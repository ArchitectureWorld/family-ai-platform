import { describe, expect, it, vi } from "vitest";
import {
  createEntryControllerHarness,
  deferred,
  entryError,
  memberContextFixture,
  pendingClaimFixture,
} from "./helpers/memberBrowserHarness.js";

const I1 = "00000000-0000-4000-8000-000000000001";
const I2 = "00000000-0000-4000-8000-000000000002";
const T1 = "00000000-0000-4000-8000-000000000101";
const T2 = "00000000-0000-4000-8000-000000000102";
const FIXED = "2026-07-25T09:00:00.000Z";
const IDENTITY = {
  familyRef: "family:0001",
  personRef: "person:alice",
  deviceRef: "device:web-alice",
};
const owner = (installationId = I1, transitionId = T1) => ({
  protocolVersion: 2,
  transitionId,
  installationId,
  createdAt: FIXED,
});
const tombstone = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 2,
  transitionId: T1,
  identity: null,
  phase: "closing",
  cookiesCleared: false,
  ...overrides,
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Member Entry cold start and Claim", () => {
  it("keeps a reloaded locked installation offline until explicit Resume", async () => {
    const env = createEntryControllerHarness({ initialMarker: true });
    const controller = env.createController();
    await controller.bootstrap();
    expect(controller.getState().name).toBe("locked");
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.api.renewWebSession).not.toHaveBeenCalled();
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(env.view.last()).toMatchObject({ showResume: true });
  });

  it.each(["DEVICE_AUTH_INVALID", "DEVICE_REVOKED"])(
    "formally revokes a cold bootstrap whose Product start rejects %s",
    async (code) => {
      const env = createEntryControllerHarness({
        initialIdentity: IDENTITY,
        workbench: {
          start: vi.fn(async () => {
            throw entryError(code);
          }),
        },
      });
      const controller = env.createController();

      await controller.bootstrap();

      expect(env.workbench.start).toHaveBeenCalledOnce();
      expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
      expect(env.cacheLifecycle.deleteIdentity).toHaveBeenCalledWith(
        IDENTITY,
        expect.any(Object),
      );
      expect(env.storage.readIdentityPointer(I1)).toBeNull();
      expect(env.storage.readInstallationId()).toBe(I2);
      expect(env.storage.readLifecycle(I1)).toMatchObject({
        state: "revoked",
      });
      expect(controller.getState().name).toBe("unpaired");

      await controller.retry();
      expect(env.workbench.start).toHaveBeenCalledOnce();
      expect(env.api.getWebContext).toHaveBeenCalledOnce();
    },
  );

  it.each(["DEVICE_AUTH_INVALID", "DEVICE_REVOKED"])(
    "preserves %s through a failing Product stop prelude and formally revokes",
    async (code) => {
      const invalidation = entryError(code, {
        cause: { secret: "HOSTILE_INVALIDATION_CAUSE" },
      });
      invalidation.message =
        "token=HOSTILE_INVALIDATION cookie=HOSTILE_INVALIDATION family:private";
      const stopFailure = entryError("STOP_FAILED", {
        cause: { secret: "HOSTILE_STOP_CAUSE" },
      });
      stopFailure.message =
        "token=HOSTILE_STOP cookie=HOSTILE_STOP family:private";
      const env = createEntryControllerHarness({
        initialIdentity: IDENTITY,
        workbench: {
          start: vi.fn(async () => {
            throw invalidation;
          }),
          stop: vi.fn()
            .mockRejectedValueOnce(stopFailure)
            .mockResolvedValue(undefined),
        },
      });
      const controller = env.createController();

      await controller.bootstrap();
      await env.channels.whenIdle();

      expect(env.workbench.start).toHaveBeenCalledOnce();
      expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
      expect(env.cacheLifecycle.deleteIdentity).toHaveBeenCalledOnce();
      expect(env.storage.readIdentityPointer(I1)).toBeNull();
      expect(env.storage.readInstallationId()).toBe(I2);
      expect(env.rotationCount).toBe(1);
      expect(controller.getState().name).toBe("unpaired");

      const publicBoundaries = JSON.stringify({
        view: env.view.states,
        channel: env.channels.posted,
        storage: env.localStorage.dump(),
      });
      expect(publicBoundaries).not.toMatch(
        /HOSTILE|token=|cookie=|family:private|cause|secret/iu,
      );
    },
  );

  it.each(["DEVICE_AUTH_INVALID", "DEVICE_REVOKED"])(
    "retries a failed formal %s revoke instead of bootstrapping into locked",
    async (code) => {
      const stopFailure = entryError("STOP_FAILED");
      const env = createEntryControllerHarness({
        initialIdentity: IDENTITY,
        workbench: {
          start: vi.fn(async () => {
            throw entryError(code);
          }),
          stop: vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(stopFailure)
            .mockResolvedValue(undefined),
        },
      });
      const controller = env.createController();

      await controller.bootstrap();

      expect(controller.getState()).toMatchObject({
        name: "recoverable_error",
        showRetry: true,
      });
      expect(env.storage.readLockMarker(I1)).not.toBeNull();
      expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();

      await controller.retry();

      expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
      expect(env.cacheLifecycle.deleteIdentity).toHaveBeenCalledOnce();
      expect(env.storage.readIdentityPointer(I1)).toBeNull();
      expect(env.storage.readInstallationId()).toBe(I2);
      expect(env.rotationCount).toBe(1);
      expect(controller.getState().name).toBe("unpaired");
    },
  );

  it.each(["DEVICE_AUTH_INVALID", "DEVICE_REVOKED"])(
    "single-flights Product callback plus matching %s startup rejection",
    async (code) => {
      const clear = deferred<void>();
      const invalidation = entryError(code);
      let callbackCalls = 0;
      let callback: Promise<boolean> | undefined;
      const env = createEntryControllerHarness({
        initialIdentity: IDENTITY,
        api: {
          clearWebEntryCookies: vi.fn(() => clear.promise),
        },
        workbench: {
          start: vi.fn(async () => {
            callbackCalls += 1;
            callback = env.controller.handleEntryFailure(invalidation, I1);
            throw invalidation;
          }),
        },
      });
      const controller = env.createController();
      env.controller = controller;

      const operation = controller.bootstrap();
      await env.http.waitForRequest("clearWebEntryCookies");

      expect(callbackCalls).toBe(1);
      expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
      clear.resolve(undefined);
      await Promise.all([operation, callback!]);
      await env.channels.whenIdle();

      expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
      expect(env.cacheLifecycle.deleteIdentity).toHaveBeenCalledOnce();
      expect(env.rotationCount).toBe(1);
      expect(env.storage.readInstallationId()).toBe(I2);
      expect(
        env.channels.posted.filter(
          (message: any) => message.type === "device-revoke-preparing",
        ),
      ).toHaveLength(1);
      expect(
        env.channels.posted.filter(
          (message: any) => message.type === "device-revoke-complete",
        ),
      ).toHaveLength(1);
      expect(
        env.view.states.filter((view: any) => view.name === "unpaired"),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["DEVICE_AUTH_INVALID", "marker"],
    ["DEVICE_AUTH_INVALID", "stop"],
    ["DEVICE_REVOKED", "marker"],
    ["DEVICE_REVOKED", "stop"],
  ])(
    "retries Context %s through a failed revoke %s prelude",
    async (code, prelude) => {
      const invalidation = entryError(code);
      const stopFailure = entryError("STOP_FAILED");
      const env = createEntryControllerHarness({
        initialIdentity: IDENTITY,
        api: {
          getWebContext: vi.fn()
            .mockRejectedValueOnce(invalidation)
            .mockResolvedValue({
              context: memberContextFixture(),
            }),
        },
        workbench: prelude === "stop"
          ? {
              stop: vi.fn()
                .mockRejectedValueOnce(stopFailure)
                .mockResolvedValue(undefined),
            }
          : undefined,
      });
      const baseStorage = env.storage;
      let markerAttempts = 0;
      const storage = prelude === "marker"
        ? new Proxy(baseStorage, {
            get(target, property, receiver) {
              if (property !== "writeLockMarkerLocked") {
                return Reflect.get(target, property, receiver);
              }
              return (...args: any[]) => {
                markerAttempts += 1;
                if (markerAttempts === 1) throw stopFailure;
                return target.writeLockMarkerLocked(...args);
              };
            },
          })
        : baseStorage;
      const controller = env.createController({ storage });

      await controller.bootstrap();

      expect(controller.getState()).toMatchObject({
        name: "recoverable_error",
        showRetry: true,
      });
      expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();

      await controller.retry();

      expect(env.api.getWebContext).toHaveBeenCalledOnce();
      expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
      expect(env.cacheLifecycle.deleteIdentity).toHaveBeenCalledOnce();
      expect(env.storage.readIdentityPointer(I1)).toBeNull();
      expect(env.storage.readInstallationId()).toBe(I2);
      expect(env.rotationCount).toBe(1);
      expect(controller.getState().name).toBe("unpaired");
    },
  );

  it("claims the exact pending material plus device and clears it only after 204", async () => {
    const response = deferred<void>();
    const requestStarted = deferred<void>();
    const env = createEntryControllerHarness({
      api: { claimWebPairing: vi.fn(() => {
        requestStarted.resolve(undefined);
        return response.promise;
      }) },
    });
    const controller = env.createController();
    const pending = pendingClaimFixture();
    const operation = controller.bootstrap({ pendingClaim: pending });
    await requestStarted.promise;
    expect(env.api.claimWebPairing).toHaveBeenCalledWith(
      { ...pending, device: env.deviceDescriptor },
      { signal: expect.any(AbortSignal) },
    );
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
    expect(env.storage.readClaimCookieIntent()).toMatchObject({
      installationId: I1,
    });
    response.resolve(undefined);
    await operation;
    expect(env.pendingClaims.clear).toHaveBeenCalledOnce();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.storage.readLifecycle(I1)).toMatchObject({
      state: "active",
      revision: 1,
    });
    expect(controller.getState().name).toBe("active");
  });

  it.each(["would-succeed", "would-revoke"])(
    "clears a stale pending Claim before fetch when it %s",
    async (outcome) => {
      const claimWebPairing = vi.fn(async () => {
        if (outcome === "would-revoke") throw entryError("DEVICE_REVOKED");
      });
      const env = createEntryControllerHarness({ api: { claimWebPairing } });
      env.localStorage.setItem("family-ai-web-installation-id", I2);
      const controller = env.createController();
      await controller.bootstrap({ pendingClaim: pendingClaimFixture(I1) });
      expect(env.pendingClaims.clear).toHaveBeenCalledOnce();
      expect(claimWebPairing).not.toHaveBeenCalled();
      expect(env.api.getWebContext).not.toHaveBeenCalled();
      expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
      expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
      expect(env.storage.readInstallationId()).toBe(I2);
      expect(controller.getState()).toMatchObject({ name: "unpaired" });
    },
  );

  it("retries a committed Claim locally without consuming another replay or revision", async () => {
    const firstFailure = entryError("INDEXED_DB_OPEN_FAILED");
    const env = createEntryControllerHarness({
      workbench: {
        start: vi.fn()
          .mockRejectedValueOnce(firstFailure)
          .mockResolvedValueOnce(true),
      },
    });
    const controller = env.createController();
    await controller.claim(pendingClaimFixture());
    const committed = env.storage.readLifecycle(I1);
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      showRetry: true,
    });
    await controller.retry();
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.api.getWebContext).toHaveBeenCalledTimes(2);
    expect(env.pendingClaims.clear).toHaveBeenCalledOnce();
    expect(env.storage.readLifecycle(I1)).toEqual(committed);
    expect(env.workbench.start).toHaveBeenCalledTimes(2);
    expect(controller.getState().name).toBe("active");
  });

  it("single-flights same-tab Claim submissions and opens a new flight after settlement", async () => {
    const response = deferred<void>();
    const requestStarted = deferred<void>();
    const env = createEntryControllerHarness({
      api: { claimWebPairing: vi.fn(() => {
        requestStarted.resolve(undefined);
        return response.promise;
      }) },
    });
    const controller = env.createController();
    const pending = pendingClaimFixture();
    const first = controller.claim(pending);
    const second = controller.claim(pending);
    expect(second).toBe(first);
    await requestStarted.promise;
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    response.resolve(undefined);
    await first;
    await controller.claim(pending);
    expect(env.api.claimWebPairing).toHaveBeenCalledTimes(2);
    expect(env.pendingClaims.shouldRetain).not.toHaveBeenCalled();
  });

  it("retains an uncertain Claim intent until one Cookie owner clears it", async () => {
    const unknown = entryError("GATEWAY_UNAVAILABLE", {
      claimOutcome: "unknown",
      retryable: true,
    });
    const clear = deferred<void>();
    const clearStarted = deferred<void>();
    const env = createEntryControllerHarness({
      api: {
        claimWebPairing: vi.fn(async () => { throw unknown; }),
        clearWebEntryCookies: vi.fn(() => {
          clearStarted.resolve(undefined);
          return clear.promise;
        }),
      },
    });
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await clearStarted.promise;
    expect(env.storage.readClaimCookieIntent()).toMatchObject({ installationId: I1 });
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    clear.resolve(undefined);
    await operation;
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      showRetry: true,
    });
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
  });

  it("destroy aborts an uncertain Claim while leaving its durable intent", async () => {
    const request = deferred<void>();
    const env = createEntryControllerHarness({
      api: { claimWebPairing: vi.fn(() => request.promise) },
    });
    const controller = env.createController();
    const claim = controller.claim(pendingClaimFixture());
    await env.http.waitForRequest("claimWebPairing");
    const intent = env.storage.readClaimCookieIntent();
    const destroying = controller.destroy();
    request.reject(entryError("ABORTED", { claimOutcome: "unknown" }));
    await Promise.all([claim, destroying]);
    expect(env.storage.readClaimCookieIntent()).toEqual(intent);
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
  });

  it("fails Claim and origin-global cleanup closed without Web Locks", async () => {
    const env = createEntryControllerHarness({ locks: null });
    const controller = env.createController();
    await controller.claim(pendingClaimFixture());
    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
    });

    env.storage.writeClaimCookieIntent(owner());
    const bytes = env.localStorage.getItem("family-ai-member-claim-cookie-intent");
    await controller.bootstrap();
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.localStorage.getItem("family-ai-member-claim-cookie-intent")).toBe(bytes);
  });

  it("recovers an expired normal session only when no marker exists", async () => {
    const expired = entryError("ENTRY_SESSION_EXPIRED");
    const env = createEntryControllerHarness({
      api: {
        getWebContext: vi.fn()
          .mockRejectedValueOnce(expired)
          .mockRejectedValueOnce(expired)
          .mockResolvedValueOnce({ context: memberContextFixture() }),
      },
    });
    const controller = env.createController();
    await controller.bootstrap();
    expect(env.api.renewWebSession).toHaveBeenCalledOnce();
    expect(env.api.getWebContext).toHaveBeenCalledTimes(3);
    expect(env.storage.readLockMarker(I1)).toBeNull();
    expect(env.storage.readLifecycle(I1)).toMatchObject({ state: "active" });
    expect(controller.getState().name).toBe("active");

    const locked = createEntryControllerHarness({ initialMarker: true });
    await locked.createController().bootstrap();
    expect(locked.api.getWebContext).not.toHaveBeenCalled();
    expect(locked.api.renewWebSession).not.toHaveBeenCalled();
  });

  it("blocks on legacy deletion and resumes an already-rotated old tombstone once", async () => {
    const legacy = deferred<void>();
    const blocked = createEntryControllerHarness({
      cacheLifecycle: { deleteLegacy: vi.fn(() => legacy.promise) },
    });
    const bootstrap = blocked.createController().bootstrap();
    await flushMicrotasks();
    expect(blocked.api.getWebContext).not.toHaveBeenCalled();
    expect(blocked.workbench.start).not.toHaveBeenCalled();
    legacy.reject(entryError("LEGACY_CACHE_DELETE_BLOCKED"));
    await bootstrap;
    expect(blocked.view.last()).toMatchObject({ name: "recoverable_error" });

    const old = createEntryControllerHarness({
      installationId: I2,
      initialTombstoneInstallationId: I1,
      initialTombstone: tombstone({ cookiesCleared: true }),
    });
    await old.createController().bootstrap();
    expect(old.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(old.storage.readInstallationId()).toBe(I2);
    expect(old.rotationCount).toBe(0);
    expect(old.storage.readCleanupTombstone(I1)).toBeNull();
  });
});

describe("Member Entry Logout, Resume and receivers", () => {
  it("writes a supported marker and stops both tabs before Logout resolves", async () => {
    const response = deferred<void>();
    const requestStarted = deferred<void>();
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
    });
    const peer = env.createTab();
    const first = env.createController();
    const second = peer.createController();
    env.api.logoutWebSession.mockImplementation(() => {
      requestStarted.resolve(undefined);
      return response.promise;
    });
    const operation = first.logout();
    await env.shared.whenIdle();
    await requestStarted.promise;
    expect(env.storage.readLockMarker(I1)).not.toBeNull();
    expect(env.workbench.stop).toHaveBeenCalled();
    expect(peer.workbench.stop).toHaveBeenCalled();
    expect(env.api.logoutWebSession).toHaveBeenCalledOnce();
    expect(first.getState().name).toBe("locked");
    response.resolve(undefined);
    await operation;
    await second.whenIdle();
    expect(env.storage.readLifecycle(I1)).toMatchObject({ state: "locked", revision: 2 });
  });

  it("keeps both tabs locked on Logout failure and leaves retry and Resume controls", async () => {
    const env = createEntryControllerHarness();
    const peer = env.createTab();
    env.api.logoutWebSession.mockRejectedValue(entryError("GATEWAY_UNAVAILABLE"));
    const first = env.createController();
    const second = peer.createController();
    await first.logout();
    await env.shared.whenIdle();
    await second.whenIdle();
    expect(first.getState()).toMatchObject({
      name: "locked",
      showResume: true,
      showRetry: true,
      serverLogoutConfirmed: false,
    });
    expect(second.getState()).toMatchObject({ name: "locked", showResume: true });
  });

  it("uses the one-way no-lock Logout exception without lifecycle publication", async () => {
    const env = createEntryControllerHarness({ locks: null });
    const peer = env.createTab({ locks: null });
    const first = env.createController();
    peer.createController();
    await first.logout();
    await env.shared.whenIdle();
    expect(env.api.logoutWebSession).toHaveBeenCalledOnce();
    expect(env.storage.readLockMarker(I1)).not.toBeNull();
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.channels.posted).toEqual([]);
    expect(peer.workbench.stop).toHaveBeenCalled();
  });

  it("serializes two simultaneous Resume clicks into one renew and two fresh starts", async () => {
    const env = createEntryControllerHarness({
      initialMarker: true,
      initialLifecycle: { state: "locked", revision: 1, transitionId: T1 },
    });
    const first = env.createController();
    const peer = env.createTab();
    peer.api.getWebContext
      .mockResolvedValueOnce({ context: memberContextFixture() });
    const second = peer.createController();
    env.api.getWebContext
      .mockRejectedValueOnce(entryError("ENTRY_SESSION_EXPIRED"))
      .mockResolvedValueOnce({ context: memberContextFixture() });
    await Promise.all([first.resume(), second.resume()]);
    expect(env.api.renewWebSession).toHaveBeenCalledOnce();
    expect(peer.api.renewWebSession).not.toHaveBeenCalled();
    expect(env.storage.readLockMarker(I1)).toBeNull();
    expect(env.storage.readLifecycle(I1)).toMatchObject({ state: "active", revision: 2 });
    expect(env.workbench.start).toHaveBeenCalledOnce();
    expect(peer.workbench.start).toHaveBeenCalledOnce();
  });

  it("preserves a newer marker and locked state when Resume loses the recheck", async () => {
    const context = deferred<any>();
    const env = createEntryControllerHarness({
      initialMarker: true,
      api: { getWebContext: vi.fn(() => context.promise) },
    });
    const controller = env.createController();
    const resume = controller.resume();
    await env.http.waitForRequest("getWebContext");
    const firstMarker = env.storage.readLockMarker(I1);
    const peer = env.createTab({ now: () => new Date("2026-07-25T09:00:01.000Z") });
    const secondMarker = await peer.mutationLock.runMarkerMutation(
      I1,
      () => peer.storage.writeLockMarkerLocked(I1),
    );
    context.resolve({ context: memberContextFixture() });
    await resume;
    await controller.whenIdle();
    expect(secondMarker).not.toEqual(firstMarker);
    expect(env.storage.readLockMarker(I1)).toEqual(secondMarker);
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(controller.getState().name).toBe("locked");
  });

  it("sends no Resume requests without Web Locks and keeps the marker", async () => {
    const env = createEntryControllerHarness({ locks: null, initialMarker: true });
    const marker = env.storage.readLockMarker(I1);
    const controller = env.createController();
    await controller.resume();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.api.renewWebSession).not.toHaveBeenCalled();
    expect(env.workbench.stop).not.toHaveBeenCalled();
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(controller.getState().name).toBe("locked");
  });

  it("re-reads shared storage for duplicate and stale lifecycle wakeups", async () => {
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 2, transitionId: T2 },
    });
    const controller = env.createController();
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-locked",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await controller.whenIdle();
    expect(controller.getState().name).toBe("active");
    expect(env.storage.readLifecycle(I1)).toMatchObject({ revision: 2, state: "active" });
  });

  it("serializes Broadcast and storage wakes so rev1 cannot overtake rev2", async () => {
    const stopped = deferred<void>();
    const env = createEntryControllerHarness();
    env.workbench.stop.mockImplementationOnce(() => stopped.promise);
    const controller = env.createController();
    env.storage.advanceLifecycle(I1, "locked", T1);
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-locked",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await flushMicrotasks();
    env.storage.advanceLifecycle(I1, "active", T2);
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T2,
      revision: 2,
      occurredAt: FIXED,
    });
    stopped.resolve(undefined);
    await controller.whenIdle();
    expect(controller.getState().name).toBe("active");
    expect(env.workbench.start).toHaveBeenCalledOnce();
  });

  it("binds every start to captured installation and lifecycle guards", async () => {
    const env = createEntryControllerHarness();
    env.workbench.start.mockImplementation(async (_context: unknown, id: string, guard: () => void) => {
      expect(id).toBe(I1);
      expect(guard).toBeTypeOf("function");
      guard();
      env.storage.advanceLifecycle(I1, "locked", T1);
      expect(guard).toThrowError(expect.objectContaining({
        code: "ENTRY_LIFECYCLE_CHANGED_DURING_START",
      }));
      return true;
    });
    const controller = env.createController();
    await controller.bootstrap();
    expect(env.workbench.stop).toHaveBeenCalled();
    expect(controller.getState().name).not.toBe("active");
  });

  it("destroy closes listeners/channel and prevents deferred active wake from rendering", async () => {
    const context = deferred<any>();
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
    });
    env.api.getWebContext.mockImplementation(() => context.promise);
    const controller = env.createController();
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await flushMicrotasks();
    const destroying = controller.destroy();
    context.resolve({ context: memberContextFixture() });
    await destroying;
    const before = env.view.states.length;
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await flushMicrotasks();
    expect(env.channels.openCount).toBe(0);
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(env.workbench.stop).toHaveBeenCalled();
    expect(env.view.states).toHaveLength(before);
    await expect(controller.destroy()).resolves.toBeUndefined();
  });

  it("destroy settles without awaiting a passive receiver", async () => {
    const context = deferred<any>();
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
      api: { getWebContext: vi.fn(() => context.promise) },
    });
    const controller = env.createController();
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await env.http.waitForRequest("getWebContext");
    await expect(controller.destroy()).resolves.toBeUndefined();
    expect(env.workbench.stop).toHaveBeenCalled();
    expect(env.channels.openCount).toBe(0);
    expect(env.workbench.start).not.toHaveBeenCalled();
  });

  it("whenIdle awaits active-wake DEVICE_REVOKED cleanup and catches cleanup rejection", async () => {
    const clear = deferred<void>();
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
    });
    env.api.getWebContext.mockRejectedValue(entryError("DEVICE_REVOKED"));
    env.api.clearWebEntryCookies.mockImplementation(() => clear.promise);
    const controller = env.createController();
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    let idle = false;
    void controller.whenIdle().then(() => { idle = true; });
    await flushMicrotasks();
    expect(idle).toBe(false);
    clear.reject(new TypeError("clear failed"));
    await controller.whenIdle();
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      code: "REVOKE_COOKIE_CLEAR_FAILED",
    });
  });

  it("ignores a stale source-bound revoke and surfaces current retryable wake errors", async () => {
    const stale = createEntryControllerHarness();
    stale.localStorage.setItem("family-ai-web-installation-id", I2);
    const staleController = stale.createController();
    await staleController.handleEntryFailure(entryError("DEVICE_REVOKED"), I1);
    expect(stale.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(stale.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(stale.storage.readInstallationId()).toBe(I2);

    const current = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
    });
    current.api.getWebContext.mockRejectedValue(entryError("PROVIDER_FAILED", {
      status: 503,
      retryable: true,
    }));
    const controller = current.createController();
    current.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await controller.whenIdle();
    expect(current.workbench.stop).toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ name: "recoverable_error" });
  });

  it("publishes only exact non-secret protocol-v2 lifecycle payloads and keeps Channel alive through stop", async () => {
    const env = createEntryControllerHarness();
    const controller = env.createController();
    await controller.logout();
    expect(env.channels.openCount).toBe(1);
    expect(env.channels.posted).toHaveLength(1);
    for (const message of env.channels.posted as any[]) {
      expect(message).toEqual({
        protocolVersion: 2,
        type: expect.stringMatching(/^(session-locked|session-restored|device-revoke-preparing|device-revoke-complete)$/),
        installationId: expect.any(String),
        transitionId: expect.any(String),
        revision: expect.any(Number),
        occurredAt: expect.any(String),
      });
      expect(JSON.stringify(message)).not.toMatch(/token|cookie|credential|pairing|message/iu);
    }
    expect(JSON.stringify(controller.getState())).not.toMatch(
      /family:0001|person:alice|device:web-alice|ABCD-EFGH|A{43}/u,
    );
    await controller.destroy();
    expect(env.channels.openCount).toBe(0);
  });
});

describe("Member Entry two-phase Revoke cleanup", () => {
  it("stops peers, publishes preparing, clears Cookies, deletes one identity, and rotates once", async () => {
    const deleteGate = deferred<void>();
    const deleteStarted = deferred<void>();
    const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
    const peer = env.createTab();
    const controller = env.createController();
    peer.createController();
    env.cacheLifecycle.deleteIdentity.mockImplementation(() => {
      deleteStarted.resolve(undefined);
      return deleteGate.promise;
    });
    const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
    await deleteStarted.promise;
    await peer.controller.whenIdle();
    expect(env.storage.readCleanupTombstone(I1)).toMatchObject({
      phase: "deleting",
      identity: IDENTITY,
      cookiesCleared: true,
    });
    expect(peer.workbench.stop).toHaveBeenCalled();
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.cacheLifecycle.deleteIdentity).toHaveBeenCalledWith(
      IDENTITY,
      { onBlocked: expect.any(Function) },
    );
    deleteGate.resolve(undefined);
    await operation;
    expect(env.storage.readIdentityPointer(I1)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.rotationCount).toBe(1);
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.channels.posted.map((message: any) => message.type)).toEqual([
      "device-revoke-preparing",
      "device-revoke-complete",
    ]);
  });

  it("keeps a blocked deletion tombstone, pointer, old installation and revoked view", async () => {
    const deletion = deferred<void>();
    const deleteStarted = deferred<void>();
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      cacheLifecycle: {
        deleteIdentity: vi.fn(async (_identity: unknown, { onBlocked }: any) => {
          onBlocked();
          deleteStarted.resolve(undefined);
          return deletion.promise;
        }),
      },
    });
    const controller = env.createController();
    const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
    await deleteStarted.promise;
    expect(controller.getState()).toMatchObject({
      name: "revoked",
      cleanupBlocked: true,
    });
    expect(env.storage.readIdentityPointer(I1)).not.toBeNull();
    expect(env.storage.readInstallationId()).toBe(I1);
    deletion.resolve(undefined);
    await operation;
  });

  it("wraps Cookie-clear failure with cause and retries the same owner", async () => {
    const cause = new TypeError("network down");
    const env = createEntryControllerHarness();
    env.api.clearWebEntryCookies
      .mockRejectedValueOnce(cause)
      .mockResolvedValueOnce(undefined);
    const controller = env.createController();
    await controller.revoke(entryError("DEVICE_REVOKED"), I1);
    const retained = env.storage.readCleanupTombstone(I1);
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      code: "REVOKE_COOKIE_CLEAR_FAILED",
    });
    expect(controller.getState().cause).toBeUndefined();
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(retained).toMatchObject({ cookiesCleared: false });
    await controller.retryCleanup(I1);
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledTimes(2);
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("cold-starts tombstone cleanup before legacy, Context, Claim or cache open", async () => {
    const env = createEntryControllerHarness({
      initialTombstone: tombstone(),
    });
    const controller = env.createController();
    await controller.bootstrap({ pendingClaim: pendingClaimFixture() });
    expect(env.cacheLifecycle.deleteLegacy).not.toHaveBeenCalled();
    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("persists target cleanup intent before touching an origin owner", async () => {
    const clear = deferred<void>();
    const clearStarted = deferred<void>();
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      initialClaimIntent: owner(),
    });
    env.api.clearWebEntryCookies.mockImplementation(() => {
      clearStarted.resolve(undefined);
      return clear.promise;
    });
    const controller = env.createController();
    const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
    await clearStarted.promise;
    expect(env.storage.readClaimCookieIntent()).toEqual(owner());
    expect(env.storage.readCleanupTombstone(I1)).toMatchObject({
      protocolVersion: 2,
      transitionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      phase: "closing",
      identity: null,
      cookiesCleared: false,
    });
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readInstallationId()).toBe(I1);
    clear.resolve(undefined);
    await operation;
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("cold-retries the owner-CAS to target-checkpoint crash gap from tombstone false", async () => {
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      initialClaimIntent: owner(),
    });
    const baseStorage = env.storage;
    let injected = false;
    const crashStorage = new Proxy(baseStorage, {
      get(target, property, receiver) {
        if (property !== "clearClaimCookieIntent") {
          return Reflect.get(target, property, receiver);
        }
        return (transitionId: string) => {
          const cleared = target.clearClaimCookieIntent(transitionId);
          if (cleared && !injected) {
            injected = true;
            throw entryError("SIMULATED_CRASH_AFTER_OWNER_CAS");
          }
          return cleared;
        };
      },
    });
    const controller = env.createController({ storage: crashStorage });
    await controller.revoke(entryError("DEVICE_REVOKED"), I1);
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toMatchObject({
      phase: "closing",
      identity: null,
      cookiesCleared: false,
    });
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    await controller.destroy();

    const reload = env.createTab();
    await reload.createController().bootstrap();
    expect(reload.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(reload.cacheLifecycle.deleteIdentity).toHaveBeenCalledWith(
      IDENTITY,
      { onBlocked: expect.any(Function) },
    );
    expect(reload.storage.readInstallationId()).toBe(I2);
    expect(reload.storage.readCleanupTombstone(I1)).toBeNull();
  });

  it("keeps no-lock Revoke fail-closed with only a sticky marker and memory view", async () => {
    const env = createEntryControllerHarness({ locks: null, initialIdentity: IDENTITY });
    const controller = env.createController();
    await controller.revoke(entryError("DEVICE_REVOKED"), I1);
    expect(env.storage.readLockMarker(I1)).not.toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.channels.posted).toEqual([]);
    expect(controller.getState()).toMatchObject({
      name: "revoked",
      code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
    });
    await controller.destroy();
    const reload = env.createTab({ locks: null });
    await reload.createController().bootstrap();
    expect(reload.controller.getState().name).toBe("locked");
    expect(reload.api.getWebContext).not.toHaveBeenCalled();
    expect(reload.api.clearWebEntryCookies).not.toHaveBeenCalled();
  });

  it("keeps no-lock Remove non-destructive and sends no request", async () => {
    const env = createEntryControllerHarness({
      locks: null,
      initialIdentity: IDENTITY,
    });
    const controller = env.createController();
    await controller.removeDevice();
    expect(env.api.revokeWebDevice).not.toHaveBeenCalled();
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.workbench.stop).not.toHaveBeenCalled();
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readIdentityPointer(I1)).toMatchObject(IDENTITY);
    expect(env.storage.readLockMarker(I1)).toBeNull();
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(I1);
  });

  it("keeps failed removeDevice locked and cleans up authoritative success without reacquiring", async () => {
    const failure = createEntryControllerHarness({ initialIdentity: IDENTITY });
    failure.api.revokeWebDevice.mockRejectedValue(entryError("GATEWAY_UNAVAILABLE"));
    const failed = failure.createController();
    await failed.removeDevice();
    expect(failed.getState()).toMatchObject({ name: "locked", showRetry: true });
    expect(failure.storage.readCleanupTombstone(I1)).toBeNull();
    expect(failure.storage.readIdentityPointer(I1)).not.toBeNull();
    expect(failure.storage.readInstallationId()).toBe(I1);

    const success = createEntryControllerHarness({ initialIdentity: IDENTITY });
    await success.createController().removeDevice();
    expect(success.api.revokeWebDevice).toHaveBeenCalledOnce();
    expect(success.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(success.cacheLifecycle.deleteIdentity).toHaveBeenCalledOnce();
    expect(success.storage.readInstallationId()).toBe(I2);
    expect(success.rotationCount).toBe(1);
  });

  it("distinguishes pairing DEVICE_AUTH_INVALID from authenticated startup invalidation", async () => {
    const terminal = createEntryControllerHarness();
    terminal.api.claimWebPairing.mockRejectedValue(Object.assign(
      entryError("DEVICE_AUTH_INVALID"),
      { claimOutcome: "rejected" },
    ));
    const first = terminal.createController();
    await first.claim(pendingClaimFixture());
    expect(terminal.pendingClaims.clear).toHaveBeenCalledOnce();
    expect(terminal.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(first.getState().name).toBe("unpaired");

    const committed = createEntryControllerHarness({
      workbench: {
        start: vi.fn(async () => { throw entryError("DEVICE_AUTH_INVALID"); }),
      },
    });
    const second = committed.createController();
    await second.claim(pendingClaimFixture());
    expect(committed.pendingClaims.clear).toHaveBeenCalledOnce();
    expect(committed.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(second.getState().name).not.toBe("active");
  });

  it("cleans a pairing DEVICE_REVOKED without an identity database", async () => {
    const env = createEntryControllerHarness();
    env.api.claimWebPairing.mockRejectedValue(Object.assign(
      entryError("DEVICE_REVOKED"),
      { claimOutcome: "rejected" },
    ));
    const controller = env.createController();
    await controller.claim(pendingClaimFixture());
    expect(env.pendingClaims.clear).toHaveBeenCalledOnce();
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("skips a second Cookie clear after the durable checkpoint and one rotation", async () => {
    const env = createEntryControllerHarness({
      installationId: I2,
      initialTombstoneInstallationId: I1,
      initialTombstone: tombstone({ cookiesCleared: true }),
    });
    const controller = env.createController();
    await controller.retryCleanup(I1);
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.rotationCount).toBe(0);
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("fails closed for rotated-away tombstones whose Cookies were not checkpointed", async () => {
    const env = createEntryControllerHarness({
      installationId: I2,
      initialTombstoneInstallationId: I1,
      initialTombstone: tombstone({ cookiesCleared: false }),
    });
    const controller = env.createController();
    await controller.retryCleanup(I1);
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      code: "ENTRY_TOMBSTONE_INCONSISTENT",
    });
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.storage.readCleanupTombstone(I1)).not.toBeNull();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("does not clear monotonic marker M2 after Claim captured M1", async () => {
    const response = deferred<void>();
    const env = createEntryControllerHarness({
      initialMarker: true,
      api: { claimWebPairing: vi.fn(() => response.promise) },
    });
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.http.waitForRequest("claimWebPairing");
    const expectedM1 = env.storage.readLockMarker(I1);
    const peer = env.createTab({ now: () => new Date("2026-07-25T09:00:01.000Z") });
    const markerM2 = await peer.mutationLock.runMarkerMutation(
      I1,
      () => peer.storage.writeLockMarkerLocked(I1),
    );
    response.resolve(undefined);
    await operation;
    expect(markerM2).not.toEqual(expectedM1);
    expect(env.storage.readLockMarker(I1)).toEqual(markerM2);
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.workbench.start).not.toHaveBeenCalled();
    await controller.retry();
    expect(env.storage.readLockMarker(I1)).toEqual(markerM2);
  });

  it("serializes an old origin Cookie clear against a new-installation Claim", async () => {
    const clear = deferred<void>();
    const env = createEntryControllerHarness({
      initialClaimIntent: owner(I1, T1),
      api: { clearWebEntryCookies: vi.fn(() => clear.promise) },
    });
    const cleanup = env.createController().bootstrap();
    await env.http.waitForRequest("clearWebEntryCookies");
    env.localStorage.setItem("family-ai-web-installation-id", I2);
    const peer = env.createTab();
    const claim = peer.createController().claim(pendingClaimFixture(I2));
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    expect(peer.api.claimWebPairing).not.toHaveBeenCalled();
    clear.resolve(undefined);
    await cleanup;
    await claim;
    expect(peer.api.claimWebPairing).toHaveBeenCalledOnce();
  });

  it("waits for a shared Product flight before sending Claim bytes", async () => {
    const env = createEntryControllerHarness();
    const lease = await env.mutationLock.acquireProductFlight(I1);
    const controller = env.createController();
    const claim = controller.claim(pendingClaimFixture());
    await env.locks.waitForEvent(
      "request",
      `family-ai-member-product-flight:${I1}`,
      "exclusive",
    );
    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    await lease.release();
    await claim;
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
  });

  it("holds a queued old Claim through authoritative removeDevice rotation", async () => {
    const deletion = deferred<void>();
    const deletionStarted = deferred<void>();
    const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
    env.cacheLifecycle.deleteIdentity.mockImplementation(() => {
      deletionStarted.resolve(undefined);
      return deletion.promise;
    });
    const remover = env.createController();
    const remove = remover.removeDevice();
    await deletionStarted.promise;
    const peer = env.createTab();
    const claim = peer.createController().claim(pendingClaimFixture(I1));
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    expect(peer.api.claimWebPairing).not.toHaveBeenCalled();
    deletion.resolve(undefined);
    await remove;
    await claim;
    expect(peer.api.claimWebPairing).not.toHaveBeenCalled();
    expect(peer.pendingClaims.clear).toHaveBeenCalled();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("uses actual owner set versus clear event causality", async () => {
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
    });
    const controller = env.createController();
    await controller.bootstrap();
    env.workbench.stop.mockClear();
    const bytes = JSON.stringify(owner());
    env.shared.dispatchToAll(
      "family-ai-member-claim-cookie-intent",
      null,
      bytes,
    );
    await controller.whenIdle();
    expect(env.workbench.stop).toHaveBeenCalled();
    env.workbench.stop.mockClear();
    env.shared.dispatchToAll(
      "family-ai-member-claim-cookie-intent",
      bytes,
      null,
    );
    await controller.whenIdle();
    expect(env.workbench.stop).not.toHaveBeenCalled();
  });

  it("awaits a reentrant Sync-originated revoke without self-deadlocking", async () => {
    const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
    let callback: Promise<boolean> | undefined;
    env.workbench.stop.mockImplementation(() => {
      if (!callback) {
        callback = env.controller.handleEntryFailure(
          entryError("DEVICE_REVOKED"),
          I1,
        );
      }
      return Promise.resolve();
    });
    const controller = env.createController();
    env.controller = controller;
    await controller.handleEntryFailure(entryError("DEVICE_REVOKED"), I1);
    if (callback) await callback;
    await controller.whenIdle();
    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.rotationCount).toBe(1);
  });

  it("revalidates current installation inside a queued marker callback", async () => {
    const env = createEntryControllerHarness();
    const markerEntered = deferred<void>();
    const releaseMarker = deferred<void>();
    const holder = env.mutationLock.runMarkerMutation(I1, async () => {
      markerEntered.resolve(undefined);
      await releaseMarker.promise;
    });
    await markerEntered.promise;
    const peer = env.createTab();
    const controller = peer.createController();
    const logout = controller.logout();
    await env.locks.waitForEvent(
      "request",
      `family-ai-member-entry-marker:${I1}`,
      "exclusive",
      2,
    );
    env.storage.rotateInstallationId(I1);
    releaseMarker.resolve(undefined);
    await holder;
    await logout;
    expect(env.storage.readLockMarker(I1)).toBeNull();
    expect(peer.api.logoutWebSession).not.toHaveBeenCalled();
    expect(peer.workbench.stop).not.toHaveBeenCalled();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it.each(["Logout", "Remove"])(
    "revalidates I1 %s after the Cookie queue and never mutates I2 Session",
    async (kind) => {
      const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
      const cookieEntered = deferred<void>();
      const releaseCookie = deferred<void>();
      const holder = env.mutationLock.runCookieMutation(async () => {
        cookieEntered.resolve(undefined);
        await releaseCookie.promise;
      });
      await cookieEntered.promise;
      const controller = env.createController();
      const operation = kind === "Logout"
        ? controller.logout()
        : controller.removeDevice();
      await env.locks.waitForEvent(
        "request",
        "family-ai-member-cookie-mutation",
        "exclusive",
        2,
      );
      env.storage.rotateInstallationId(I1);
      releaseCookie.resolve(undefined);
      await holder;
      await operation;
      expect(env.api.logoutWebSession).not.toHaveBeenCalled();
      expect(env.api.revokeWebDevice).not.toHaveBeenCalled();
      expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
      expect(env.storage.readInstallationId()).toBe(I2);
    },
  );

  it("never sends a Claim that was queued behind Product after destroy", async () => {
    const env = createEntryControllerHarness();
    const lease = await env.mutationLock.acquireProductFlight(I1);
    const controller = env.createController();
    const claim = controller.claim(pendingClaimFixture());
    await env.locks.waitForEvent(
      "request",
      `family-ai-member-product-flight:${I1}`,
      "exclusive",
    );
    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    const destroying = controller.destroy();
    await lease.release();
    await Promise.all([claim, destroying]);
    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
  });

  it("ignores unknown-installation Broadcast wakeups without stopping Product", async () => {
    const env = createEntryControllerHarness();
    const controller = env.createController();
    await controller.bootstrap();
    env.workbench.stop.mockClear();
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-locked",
      installationId: "00000000-0000-4000-8000-000000009999",
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await controller.whenIdle();
    expect(env.workbench.stop).not.toHaveBeenCalled();
    expect(controller.getState().name).toBe("active");
  });

  it("fails closed when an active wake has missing lifecycle evidence", async () => {
    const env = createEntryControllerHarness();
    const controller = env.createController();
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await controller.whenIdle();
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      code: "ENTRY_LIFECYCLE_MISSING",
    });
  });

  it("sanitizes arbitrary dependency errors out of view and cloned state", async () => {
    const env = createEntryControllerHarness({
      cacheLifecycle: {
        deleteLegacy: vi.fn(async () => {
          throw Object.assign(new Error(
            "token=secret cookie=secret pairing=secret family:private",
          ), { code: "INTERNAL_SECRET_CODE" });
        }),
      },
    });
    const controller = env.createController();
    await controller.bootstrap();
    const first = controller.getState();
    expect(first).toEqual(expect.objectContaining({
      name: "recoverable_error",
      code: "GATEWAY_UNAVAILABLE",
      message: expect.any(String),
    }));
    expect(JSON.stringify(first)).not.toMatch(
      /secret|token|cookie|pairing|family:private|INTERNAL_SECRET_CODE/iu,
    );
    first.name = "tampered";
    expect(controller.getState().name).toBe("recoverable_error");
  });

  it("never replays a committed Claim when pending clear fails after 204", async () => {
    const env = createEntryControllerHarness();
    env.pendingClaims.clear
      .mockImplementationOnce(() => { throw entryError("PENDING_CLEAR_FAILED"); })
      .mockImplementationOnce(() => undefined);
    const controller = env.createController();
    await controller.claim(pendingClaimFixture());
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(controller.getState().name).toBe("recoverable_error");
    await controller.retry();
    expect(env.pendingClaims.clear).toHaveBeenCalledTimes(2);
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.workbench.start).toHaveBeenCalledOnce();
    expect(controller.getState().name).toBe("active");
  });

  it("checks every pointer and tombstone CAS result before rotation", async () => {
    const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
    const baseStorage = env.storage;
    const refusingStorage = new Proxy(baseStorage, {
      get(target, property, receiver) {
        if (property === "clearIdentityPointer") return () => false;
        return Reflect.get(target, property, receiver);
      },
    });
    const controller = env.createController({ storage: refusingStorage });
    await controller.revoke(entryError("DEVICE_REVOKED"), I1);
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.storage.readIdentityPointer(I1)).not.toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toMatchObject({
      phase: "deleting",
      identity: IDENTITY,
      cookiesCleared: true,
    });
    expect(controller.getState()).toMatchObject({ name: "recoverable_error" });
  });
});

describe("Member Entry review race regressions", () => {
  it("does not let a stale I1 Remove clear a queued I2 Claim owner", async () => {
    const cookieEntered = deferred<void>();
    const releaseCookie = deferred<void>();
    const stopEntered = deferred<void>();
    const releaseStop = deferred<void>();
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      workbench: {
        stop: vi.fn(() => {
          stopEntered.resolve(undefined);
          return releaseStop.promise;
        }),
      },
    });
    const holder = env.mutationLock.runCookieMutation(async () => {
      cookieEntered.resolve(undefined);
      await releaseCookie.promise;
    });
    await cookieEntered.promise;

    const operation = env.createController().removeDevice();
    await stopEntered.promise;
    expect(env.storage.readLockMarker(I1)).not.toBeNull();

    env.storage.rotateInstallationId(I1);
    const i2Owner = owner(I2, T2);
    env.storage.writeClaimCookieIntent(i2Owner);
    releaseStop.resolve(undefined);
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    releaseCookie.resolve(undefined);
    await Promise.all([holder, operation]);

    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.api.revokeWebDevice).not.toHaveBeenCalled();
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readClaimCookieIntent()).toEqual(i2Owner);
    expect(env.storage.readIdentityPointer(I1)).toEqual({
      protocolVersion: 2,
      ...IDENTITY,
    });
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("aborts Claim before bytes when M2 arrives while Product exclusive is queued", async () => {
    const env = createEntryControllerHarness({ initialMarker: true });
    const expectedM1 = env.storage.readLockMarker(I1);
    const lease = await env.mutationLock.acquireProductFlight(I1);
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.locks.waitForEvent(
      "request",
      `family-ai-member-product-flight:${I1}`,
      "exclusive",
    );
    const unsentIntent = env.storage.readClaimCookieIntent();
    expect(unsentIntent).not.toBeNull();

    const peer = env.createTab({
      now: () => new Date("2026-07-25T09:00:01.000Z"),
    });
    const markerM2 = await peer.mutationLock.runMarkerMutation(
      I1,
      () => peer.storage.writeLockMarkerLocked(I1),
    );
    expect(markerM2).not.toEqual(expectedM1);
    await lease.release();
    await operation;

    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.storage.readLockMarker(I1)).toEqual(markerM2);
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(controller.getState().name).toBe("locked");
  });

  it("does not fetch Context when M2 arrives during a committed Claim response", async () => {
    const response = deferred<void>();
    const env = createEntryControllerHarness({
      initialMarker: true,
      api: { claimWebPairing: vi.fn(() => response.promise) },
    });
    const expectedM1 = env.storage.readLockMarker(I1);
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.http.waitForRequest("claimWebPairing");

    const peer = env.createTab({
      now: () => new Date("2026-07-25T09:00:01.000Z"),
    });
    const markerM2 = await peer.mutationLock.runMarkerMutation(
      I1,
      () => peer.storage.writeLockMarkerLocked(I1),
    );
    expect(markerM2).not.toEqual(expectedM1);
    response.resolve(undefined);
    await operation;

    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.pendingClaims.clear).toHaveBeenCalledOnce();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.storage.readLockMarker(I1)).toEqual(markerM2);
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(controller.getState().name).toBe("locked");
    await controller.retry();
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
  });

  it("keeps explicit Resume locked when M1 changes to M2 in the Cookie queue", async () => {
    const env = createEntryControllerHarness({
      initialMarker: true,
      initialLifecycle: { state: "locked", revision: 1, transitionId: T1 },
    });
    const expectedM1 = env.storage.readLockMarker(I1);
    const cookieEntered = deferred<void>();
    const releaseCookie = deferred<void>();
    const holder = env.mutationLock.runCookieMutation(async () => {
      cookieEntered.resolve(undefined);
      await releaseCookie.promise;
    });
    await cookieEntered.promise;

    const controller = env.createController();
    const operation = controller.resume();
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    const peer = env.createTab({
      now: () => new Date("2026-07-25T09:00:01.000Z"),
    });
    const markerM2 = await peer.mutationLock.runMarkerMutation(
      I1,
      () => peer.storage.writeLockMarkerLocked(I1),
    );
    expect(markerM2).not.toEqual(expectedM1);
    releaseCookie.resolve(undefined);
    await Promise.all([holder, operation]);

    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.api.renewWebSession).not.toHaveBeenCalled();
    expect(env.storage.readLockMarker(I1)).toEqual(markerM2);
    expect(env.storage.readLifecycle(I1)).toMatchObject({
      state: "locked",
      revision: 1,
      transitionId: T1,
    });
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(controller.getState().name).toBe("locked");
  });

  it("stops active Product when the current lifecycle storage record is deleted", async () => {
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
    });
    const controller = env.createController();
    await controller.bootstrap();
    expect(controller.getState().name).toBe("active");
    expect(env.workbench.start).toHaveBeenCalledOnce();
    env.workbench.stop.mockClear();

    const peer = env.createTab();
    peer.localStorage.removeItem(`family-ai-member-entry-state:${I1}`);
    await env.shared.whenIdle();
    await controller.whenIdle();

    expect(env.workbench.stop).toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      code: "ENTRY_LIFECYCLE_MISSING",
    });
    expect(controller.getState().name).not.toBe("active");
  });

  it("converges a revoked peer to unpaired after leader cleanup completes", async () => {
    const deletion = deferred<void>();
    const deletionStarted = deferred<void>();
    const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
    env.cacheLifecycle.deleteIdentity.mockImplementation(() => {
      deletionStarted.resolve(undefined);
      return deletion.promise;
    });
    const peer = env.createTab();
    const leaderController = env.createController();
    const peerController = peer.createController();

    const operation = leaderController.revoke(entryError("DEVICE_REVOKED"), I1);
    await deletionStarted.promise;
    await env.channels.whenIdle();
    await env.shared.whenIdle();
    await peerController.whenIdle();
    expect(peerController.getState().name).toBe("revoked");

    deletion.resolve(undefined);
    await operation;
    await env.channels.whenIdle();
    await env.shared.whenIdle();
    await peerController.whenIdle();

    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(peerController.getState().name).toBe("unpaired");
  });

  it("binds a revoked peer Retry to the retained old tombstone cleanup", async () => {
    const retryStarted = deferred<void>();
    const releaseRetry = deferred<void>();
    const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
    env.cacheLifecycle.deleteIdentity.mockRejectedValue(
      entryError("MEMBER_CACHE_DELETE_FAILED"),
    );
    const peer = env.createTab({
      cacheLifecycle: {
        deleteIdentity: vi.fn(() => {
          retryStarted.resolve(undefined);
          return releaseRetry.promise;
        }),
      },
    });
    const leaderController = env.createController();
    const peerController = peer.createController();

    await leaderController.revoke(entryError("DEVICE_REVOKED"), I1);
    await env.channels.whenIdle();
    await env.shared.whenIdle();
    await peerController.whenIdle();
    expect(peerController.getState().name).toBe("revoked");
    expect(env.storage.readCleanupTombstone(I1)).toMatchObject({
      phase: "deleting",
      cookiesCleared: true,
      identity: IDENTITY,
    });
    const cookieRequestsBefore = env.locks.events.filter((event: any) =>
      event.phase === "request" &&
      event.name === "family-ai-member-cookie-mutation"
    ).length;

    const retry = peerController.retry();
    const firstOutcome = await Promise.race([
      retryStarted.promise.then(() => "started"),
      retry.then(() => "returned"),
    ]);
    expect(firstOutcome).toBe("started");
    releaseRetry.resolve(undefined);
    await retry;

    const cookieRequestsAfter = env.locks.events.filter((event: any) =>
      event.phase === "request" &&
      event.name === "family-ai-member-cookie-mutation"
    ).length;
    expect(cookieRequestsAfter).toBeGreaterThan(cookieRequestsBefore);
    expect(peer.cacheLifecycle.deleteIdentity).toHaveBeenCalledOnce();
    expect(peer.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(peer.rotationCount).toBe(1);
    expect(peer.storage.readInstallationId()).toBe(I2);
    expect(peer.storage.readCleanupTombstone(I1)).toBeNull();
    expect(peerController.getState().name).toBe("unpaired");
  });

  it("ignores a delayed old-installation wake while the current Product is active", async () => {
    const env = createEntryControllerHarness({
      installationId: I2,
      initialLifecycle: { state: "active", revision: 1, transitionId: T2 },
    });
    env.storage.advanceLifecycle(I1, "revoked", T1);
    const controller = env.createController();
    await controller.bootstrap();
    expect(controller.getState().name).toBe("active");
    env.workbench.stop.mockClear();

    const peer = env.createTab();
    peer.localStorage.removeItem(`family-ai-member-entry-state:${I1}`);
    await env.shared.whenIdle();
    await controller.whenIdle();

    expect(env.workbench.stop).not.toHaveBeenCalled();
    expect(controller.getState().name).toBe("active");
  });

  it("awaits the same active Revoke from an independent second invalidation", async () => {
    const clear = deferred<void>();
    const env = createEntryControllerHarness({
      api: { clearWebEntryCookies: vi.fn(() => clear.promise) },
    });
    const controller = env.createController();
    const first = controller.handleEntryFailure(
      entryError("DEVICE_REVOKED"),
      I1,
    );
    await env.http.waitForRequest("clearWebEntryCookies");

    const second = controller.handleEntryFailure(
      entryError("DEVICE_REVOKED"),
      I1,
    );
    const inspection = deferred<void>();
    const beforeRelease = Promise.race([
      second.then(() => "settled"),
      inspection.promise.then(() => "pending"),
    ]);
    inspection.resolve(undefined);
    const outcome = await beforeRelease;
    clear.resolve(undefined);
    await Promise.all([first, second]);

    expect(outcome).toBe("pending");
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.rotationCount).toBe(1);
  });

  it("lets a fire-and-forget stop callback await Revoke without self-deadlock", async () => {
    const clear = deferred<void>();
    const callbackStarted = deferred<void>();
    let callback: Promise<boolean> | undefined;
    const env = createEntryControllerHarness({
      api: { clearWebEntryCookies: vi.fn(() => clear.promise) },
    });
    env.workbench.stop.mockImplementation(() => {
      if (!callback && env.controller) {
        callback = env.controller.handleEntryFailure(
          entryError("DEVICE_REVOKED"),
          I1,
        );
        callbackStarted.resolve(undefined);
      }
      return Promise.resolve();
    });
    const controller = env.createController();
    env.controller = controller;

    const operation = controller.handleEntryFailure(
      entryError("DEVICE_REVOKED"),
      I1,
    );
    await callbackStarted.promise;
    await env.http.waitForRequest("clearWebEntryCookies");
    const callbackPromise = callback!;
    const inspection = deferred<void>();
    const beforeRelease = Promise.race([
      callbackPromise.then(() => "settled"),
      inspection.promise.then(() => "pending"),
    ]);
    inspection.resolve(undefined);
    const outcome = await beforeRelease;
    clear.resolve(undefined);
    await Promise.all([operation, callbackPromise]);

    expect(outcome).toBe("pending");
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.storage.readInstallationId()).toBe(I2);
  });

  it("resolves a failed receiver lane and still applies the next I1 revision", async () => {
    const firstContext = deferred<any>();
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
      api: {
        getWebContext: vi.fn()
          .mockImplementationOnce(() => firstContext.promise)
          .mockResolvedValueOnce({ context: memberContextFixture() }),
      },
    });
    env.workbench.stop
      .mockRejectedValueOnce(entryError("STOP_FAILED"))
      .mockResolvedValue(undefined);
    const controller = env.createController();

    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await env.channels.whenIdle();
    await env.http.waitForRequest("getWebContext");
    firstContext.reject(entryError("PROVIDER_FAILED", { retryable: true }));
    const firstIdle = await controller.whenIdle().then(
      () => "resolved",
      () => "rejected",
    );

    const next = env.storage.advanceLifecycle(I1, "active", T2);
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: next.transitionId,
      revision: next.revision,
      occurredAt: FIXED,
    });
    await env.channels.whenIdle();
    const secondIdle = await controller.whenIdle().then(
      () => "resolved",
      () => "rejected",
    );

    expect({
      firstIdle,
      secondIdle,
      contexts: env.api.getWebContext.mock.calls.length,
      starts: env.workbench.start.mock.calls.length,
      startedInstallationId: env.workbench.start.mock.calls[0]?.[1] ?? null,
      state: controller.getState().name,
    }).toEqual({
      firstIdle: "resolved",
      secondIdle: "resolved",
      contexts: 2,
      starts: 1,
      startedInstallationId: I1,
      state: "active",
    });
  });

  it.each([
    ["supported", {}],
    ["no-lock", { locks: null }],
  ])(
    "keeps every destroyed public mutator inert with %s coordination",
    async (_kind, options) => {
      const env = createEntryControllerHarness({
        initialIdentity: IDENTITY,
        ...options,
      });
      const controller = env.createController();
      await controller.destroy();
      env.workbench.start.mockClear();
      env.workbench.stop.mockClear();
      env.cacheLifecycle.deleteIdentity.mockClear();
      env.pendingClaims.clear.mockClear();
      const before = {
        storage: env.localStorage.dump(),
        http: env.http.events.length,
        posted: env.channels.posted.length,
        views: env.view.states.length,
        rotations: env.rotationCount,
        openChannels: env.channels.openCount,
      };

      const operations = [
        controller.bootstrap({ pendingClaim: pendingClaimFixture() }),
        controller.claim(pendingClaimFixture()),
        controller.logout(),
        controller.resume(),
        controller.removeDevice(),
        controller.revoke(entryError("DEVICE_REVOKED"), I1),
        controller.retry(),
        controller.retryCleanup(I1),
        controller.handleEntryFailure(entryError("DEVICE_REVOKED"), I1),
        controller.destroy(),
      ];
      await Promise.all(operations);

      expect({
        storage: env.localStorage.dump(),
        httpDelta: env.http.events.length - before.http,
        postedDelta: env.channels.posted.length - before.posted,
        viewDelta: env.view.states.length - before.views,
        rotationDelta: env.rotationCount - before.rotations,
        openChannels: env.channels.openCount,
        starts: env.workbench.start.mock.calls.length,
        stops: env.workbench.stop.mock.calls.length,
        deletes: env.cacheLifecycle.deleteIdentity.mock.calls.length,
        pendingClears: env.pendingClaims.clear.mock.calls.length,
      }).toEqual({
        storage: before.storage,
        httpDelta: 0,
        postedDelta: 0,
        viewDelta: 0,
        rotationDelta: 0,
        openChannels: before.openChannels,
        starts: 0,
        stops: 0,
        deletes: 0,
        pendingClears: 0,
      });
    },
  );

  it("cancels a supported Revoke queued on Cookie when destroy wins", async () => {
    const cookieEntered = deferred<void>();
    const releaseCookie = deferred<void>();
    const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
    const holder = env.mutationLock.runCookieMutation(async () => {
      cookieEntered.resolve(undefined);
      await releaseCookie.promise;
    });
    await cookieEntered.promise;
    const controller = env.createController();
    const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    const marker = env.storage.readLockMarker(I1);
    expect(marker).not.toBeNull();
    await controller.destroy();
    const afterDestroy = {
      posted: env.channels.posted.length,
      views: env.view.states.length,
      stops: env.workbench.stop.mock.calls.length,
      lifecycle: env.storage.readLifecycle(I1),
    };

    releaseCookie.resolve(undefined);
    await Promise.all([holder, operation]);

    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.rotationCount).toBe(0);
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readLifecycle(I1)).toEqual(afterDestroy.lifecycle);
    expect(env.storage.readIdentityPointer(I1)).toMatchObject(IDENTITY);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
    expect(env.workbench.stop).toHaveBeenCalledTimes(afterDestroy.stops);
  });

  it("checkpoints a clear already started at destroy but performs no later cleanup", async () => {
    const clear = deferred<void>();
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      initialClaimIntent: owner(),
      api: { clearWebEntryCookies: vi.fn(() => clear.promise) },
    });
    const controller = env.createController();
    const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
    await env.http.waitForRequest("clearWebEntryCookies");
    const marker = env.storage.readLockMarker(I1);
    const target = env.storage.readCleanupTombstone(I1);
    expect(marker).not.toBeNull();
    expect(target).toMatchObject({ cookiesCleared: false, phase: "closing" });
    await controller.destroy();
    const afterDestroy = {
      posted: env.channels.posted.length,
      views: env.view.states.length,
      stops: env.workbench.stop.mock.calls.length,
      lifecycle: env.storage.readLifecycle(I1),
    };

    clear.resolve(undefined);
    await operation;
    await env.channels.whenIdle();

    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toEqual({
      ...target,
      cookiesCleared: true,
    });
    expect(env.storage.readLifecycle(I1)).toEqual(afterDestroy.lifecycle);
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readIdentityPointer(I1)).toMatchObject(IDENTITY);
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.rotationCount).toBe(0);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
    expect(env.workbench.stop).toHaveBeenCalledTimes(afterDestroy.stops);
  });

  it.each(["missing", "replaced"])(
    "fails closed when initial tombstone write lies with backing %s",
    async (mode) => {
      const env = createEntryControllerHarness({ initialIdentity: IDENTITY });
      const baseStorage = env.storage;
      let writes = 0;
      let replacement: any = null;
      const lyingStorage = new Proxy(baseStorage, {
        get(target, property, receiver) {
          if (property !== "writeCleanupTombstone") {
            return Reflect.get(target, property, receiver);
          }
          return (installationId: string, record: any) => {
            writes += 1;
            if (writes === 1) {
              if (mode === "replaced") {
                replacement = target.writeCleanupTombstone(installationId, {
                  ...record,
                  transitionId: T2,
                });
              }
              return structuredClone(record);
            }
            return target.writeCleanupTombstone(installationId, record);
          };
        },
      });
      const controller = env.createController({ storage: lyingStorage });

      await controller.revoke(entryError("DEVICE_REVOKED"), I1);

      expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
      expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
      expect(env.storage.readInstallationId()).toBe(I1);
      expect(env.rotationCount).toBe(0);
      expect(env.storage.readIdentityPointer(I1)).toMatchObject(IDENTITY);
      expect(env.storage.readCleanupTombstone(I1)).toEqual(replacement);
      expect(env.storage.readLifecycle(I1)).toBeNull();
      expect(env.storage.readLockMarker(I1)).not.toBeNull();
      expect(controller.getState()).toMatchObject({
        name: "recoverable_error",
        code: "ENTRY_CLEANUP_CHECKPOINT_FAILED",
      });
    },
  );

  it.each(["retained", "replaced"])(
    "rejects a lying owner clear whose exact owner is %s",
    async (mode) => {
      const clear = deferred<void>();
      const initialOwner = owner(I1, T1);
      const changedOwner = owner(I1, T2);
      const env = createEntryControllerHarness({
        initialIdentity: IDENTITY,
        initialClaimIntent: initialOwner,
        api: { clearWebEntryCookies: vi.fn(() => clear.promise) },
      });
      const baseStorage = env.storage;
      const lyingStorage = new Proxy(baseStorage, {
        get(target, property, receiver) {
          if (property !== "clearClaimCookieIntent") {
            return Reflect.get(target, property, receiver);
          }
          return () => {
            if (mode === "replaced") {
              env.localStorage.setItem(
                "family-ai-member-claim-cookie-intent",
                JSON.stringify(changedOwner),
              );
            }
            return true;
          };
        },
      });
      const controller = env.createController({ storage: lyingStorage });
      const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
      await env.http.waitForRequest("clearWebEntryCookies");
      const target = env.storage.readCleanupTombstone(I1);
      const marker = env.storage.readLockMarker(I1);
      const lifecycle = env.storage.readLifecycle(I1);
      clear.resolve(undefined);
      await operation;

      expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
      expect(env.storage.readClaimCookieIntent()).toEqual(
        mode === "replaced" ? changedOwner : initialOwner,
      );
      expect(env.storage.readCleanupTombstone(I1)).toEqual(target);
      expect(env.storage.readLifecycle(I1)).toEqual(lifecycle);
      expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
      expect(env.storage.readIdentityPointer(I1)).toMatchObject(IDENTITY);
      expect(env.storage.readLockMarker(I1)).toEqual(marker);
      expect(env.storage.readInstallationId()).toBe(I1);
      expect(env.rotationCount).toBe(0);
      expect(controller.getState()).toMatchObject({
        name: "recoverable_error",
        code: "ENTRY_COOKIE_OWNER_CHANGED",
      });
    },
  );

  it("does not clear a rotated old marker without exact tombstone authority", async () => {
    const env = createEntryControllerHarness({ installationId: I2 });
    const marker = env.storage.writeLockMarkerLocked(I1);
    const baseStorage = env.storage;
    const clearMarker = vi.fn((installationId: string, expected: any) =>
      baseStorage.clearLockMarkerLocked(installationId, expected)
    );
    const observedStorage = new Proxy(baseStorage, {
      get(target, property, receiver) {
        if (property === "clearLockMarkerLocked") return clearMarker;
        return Reflect.get(target, property, receiver);
      },
    });
    const controller = env.createController({ storage: observedStorage });

    await controller.retryCleanup(I1);

    expect(clearMarker).not.toHaveBeenCalled();
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
  });

  it("clears only the exact rotated old marker authorized by its tombstone", async () => {
    const env = createEntryControllerHarness({
      installationId: I2,
      initialTombstoneInstallationId: I1,
      initialTombstone: tombstone({ cookiesCleared: true }),
    });
    const marker = env.storage.writeLockMarkerLocked(I1);
    const baseStorage = env.storage;
    const clearMarker = vi.fn((installationId: string, expected: any) =>
      baseStorage.clearLockMarkerLocked(installationId, expected)
    );
    const observedStorage = new Proxy(baseStorage, {
      get(target, property, receiver) {
        if (property === "clearLockMarkerLocked") return clearMarker;
        return Reflect.get(target, property, receiver);
      },
    });
    const controller = env.createController({ storage: observedStorage });

    await controller.retryCleanup(I1);

    expect(clearMarker).toHaveBeenCalledOnce();
    expect(clearMarker).toHaveBeenCalledWith(I1, marker);
    expect(env.storage.readLockMarker(I1)).toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.rotationCount).toBe(0);
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
  });

  it("maps cache delete failure to its fixed safe public error", async () => {
    const hostile = Object.assign(
      new Error("token=HOSTILE cookie=HOSTILE family:private"),
      {
        code: "MEMBER_CACHE_DELETE_FAILED",
        cause: { secret: "HOSTILE_CAUSE" },
      },
    );
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      cacheLifecycle: {
        deleteIdentity: vi.fn(async () => { throw hostile; }),
      },
    });
    const controller = env.createController();

    await controller.revoke(entryError("DEVICE_REVOKED"), I1);

    const state = controller.getState();
    expect(state).toMatchObject({
      name: "recoverable_error",
      code: "MEMBER_CACHE_DELETE_FAILED",
      message: expect.any(String),
      showRetry: true,
    });
    expect(JSON.stringify(state)).not.toMatch(
      /HOSTILE|token|cookie|family:private|cause|secret/iu,
    );
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.storage.readIdentityPointer(I1)).toMatchObject(IDENTITY);
    expect(env.storage.readCleanupTombstone(I1)).toMatchObject({
      phase: "deleting",
      cookiesCleared: true,
      identity: IDENTITY,
    });
  });

  it("finishes owner and target cleanup in one cold bootstrap pass", async () => {
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      initialClaimIntent: owner(),
      initialTombstone: tombstone(),
    });
    const controller = env.createController();

    await controller.bootstrap({ pendingClaim: pendingClaimFixture() });

    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.cacheLifecycle.deleteIdentity).toHaveBeenCalledOnce();
    expect(env.storage.readIdentityPointer(I1)).toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.rotationCount).toBe(1);
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    expect(env.cacheLifecycle.deleteLegacy).not.toHaveBeenCalled();
    expect(controller.getState().name).toBe("unpaired");
  });

  it("delivers BroadcastChannel messages asynchronously in FIFO order without echo", async () => {
    const env = createEntryControllerHarness();
    const sender = new env.channels.Channel("review-fifo");
    const firstPeer = new env.channels.Channel("review-fifo");
    const secondPeer = new env.channels.Channel("review-fifo");
    const otherName = new env.channels.Channel("review-other");
    const senderMessages: string[] = [];
    const firstMessages: string[] = [];
    const secondMessages: string[] = [];
    const otherMessages: string[] = [];
    sender.addEventListener("message", (event: any) =>
      senderMessages.push(event.data.id)
    );
    firstPeer.addEventListener("message", (event: any) =>
      firstMessages.push(event.data.id)
    );
    secondPeer.addEventListener("message", (event: any) =>
      secondMessages.push(event.data.id)
    );
    otherName.addEventListener("message", (event: any) =>
      otherMessages.push(event.data.id)
    );

    sender.postMessage({ id: "A" });
    sender.postMessage({ id: "B" });
    expect(firstMessages).toEqual([]);
    expect(secondMessages).toEqual([]);
    expect(senderMessages).toEqual([]);
    await env.channels.whenIdle();

    expect(firstMessages).toEqual(["A", "B"]);
    expect(secondMessages).toEqual(["A", "B"]);
    expect(senderMessages).toEqual([]);
    expect(otherMessages).toEqual([]);
    firstPeer.close();
    expect(() => firstPeer.postMessage({ id: "late" })).toThrowError(
      "CHANNEL_CLOSED",
    );
    sender.close();
    secondPeer.close();
    otherName.close();
  });
});

describe("Member Entry second-review RED inventory", () => {
  it("blocks Claim bytes when the exact lifecycle baseline changes behind Product", async () => {
    const env = createEntryControllerHarness({ initialMarker: true });
    const marker = env.storage.readLockMarker(I1);
    const lease = await env.mutationLock.acquireProductFlight(I1);
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.locks.waitForEvent(
      "request",
      `family-ai-member-product-flight:${I1}`,
      "exclusive",
    );
    expect(env.storage.readClaimCookieIntent()).not.toBeNull();

    const newerLifecycle = env.storage.advanceLifecycle(I1, "active", T2);
    await lease.release();
    await operation;

    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
    expect(env.storage.readLifecycle(I1)).toEqual(newerLifecycle);
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(controller.getState().name).not.toBe("active");
  });

  it("does not fetch Claim Context after the lifecycle baseline changes post-204", async () => {
    const response = deferred<void>();
    const env = createEntryControllerHarness({
      initialMarker: true,
      api: { claimWebPairing: vi.fn(() => response.promise) },
    });
    const marker = env.storage.readLockMarker(I1);
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.http.waitForRequest("claimWebPairing");

    const newerLifecycle = env.storage.advanceLifecycle(I1, "active", T2);
    response.resolve(undefined);
    await operation;

    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.pendingClaims.clear).toHaveBeenCalledOnce();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.storage.readLifecycle(I1)).toEqual(newerLifecycle);
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.workbench.start).not.toHaveBeenCalled();

    await controller.retry();
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.storage.readLifecycle(I1)).toEqual(newerLifecycle);
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
  });

  it.each(["retained", "replaced"])(
    "rejects a successful Claim intent clear whose backing is %s",
    async (mode) => {
      const env = createEntryControllerHarness();
      const baseStorage = env.storage;
      const replacement = owner(I1, T2);
      const lyingStorage = new Proxy(baseStorage, {
        get(target, property, receiver) {
          if (property !== "clearClaimCookieIntent") {
            return Reflect.get(target, property, receiver);
          }
          return () => {
            if (mode === "replaced") {
              env.localStorage.setItem(
                "family-ai-member-claim-cookie-intent",
                JSON.stringify(replacement),
              );
            }
            return true;
          };
        },
      });
      const controller = env.createController({ storage: lyingStorage });

      await controller.claim(pendingClaimFixture());

      expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
      expect(env.storage.readClaimCookieIntent()).toEqual(
        mode === "replaced"
          ? replacement
          : expect.objectContaining({ installationId: I1 }),
      );
      expect(env.pendingClaims.clear).not.toHaveBeenCalled();
      expect(env.api.getWebContext).not.toHaveBeenCalled();
      expect(env.storage.readLifecycle(I1)).toBeNull();
      expect(env.workbench.start).not.toHaveBeenCalled();
      expect(controller.getState()).toMatchObject({
        name: "recoverable_error",
        code: "ENTRY_CLAIM_INTENT_CHANGED",
      });
    },
  );

  it("fails closed when its own successful Claim lifecycle is deleted", async () => {
    const env = createEntryControllerHarness();
    const controller = env.createController();
    await controller.claim(pendingClaimFixture());
    expect(env.storage.readLifecycle(I1)).toMatchObject({
      state: "active",
      revision: 1,
    });
    expect(controller.getState().name).toBe("active");
    env.workbench.stop.mockClear();

    const peer = env.createTab();
    peer.localStorage.removeItem(`family-ai-member-entry-state:${I1}`);
    await env.shared.whenIdle();
    await controller.whenIdle();

    expect(env.workbench.stop).toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      name: "recoverable_error",
      code: "ENTRY_LIFECYCLE_MISSING",
    });
    expect(controller.getState().name).not.toBe("active");
  });
});

describe("Member Entry second-review destroy RED inventory", () => {
  it("keeps no-lock Logout inert when destroy wins during the initial stop", async () => {
    const stopEntered = deferred<void>();
    const releaseStop = deferred<void>();
    const env = createEntryControllerHarness({
      locks: null,
      workbench: {
        stop: vi.fn(() => {
          stopEntered.resolve(undefined);
          return releaseStop.promise;
        }),
      },
    });
    const controller = env.createController();
    const operation = controller.logout();
    await stopEntered.promise;
    const marker = env.storage.readLockMarker(I1);
    expect(marker).not.toBeNull();

    const destroying = controller.destroy();
    const afterDestroy = {
      storage: env.localStorage.dump(),
      posted: env.channels.posted.length,
      views: env.view.states.length,
    };
    releaseStop.resolve(undefined);
    await Promise.all([operation, destroying]);

    expect(env.api.logoutWebSession).not.toHaveBeenCalled();
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.localStorage.dump()).toEqual(afterDestroy.storage);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
  });

  it("cancels supported Logout queued on Cookie when destroy wins", async () => {
    const cookieEntered = deferred<void>();
    const releaseCookie = deferred<void>();
    const env = createEntryControllerHarness();
    const holder = env.mutationLock.runCookieMutation(async () => {
      cookieEntered.resolve(undefined);
      await releaseCookie.promise;
    });
    await cookieEntered.promise;
    const controller = env.createController();
    const operation = controller.logout();
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    const marker = env.storage.readLockMarker(I1);
    const lifecycle = env.storage.readLifecycle(I1);
    await controller.destroy();
    const afterDestroy = {
      posted: env.channels.posted.length,
      views: env.view.states.length,
    };

    releaseCookie.resolve(undefined);
    await Promise.all([holder, operation]);

    expect(env.api.logoutWebSession).not.toHaveBeenCalled();
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readLifecycle(I1)).toEqual(lifecycle);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
  });

  it("cancels durable owner bootstrap cleanup queued on Cookie after destroy", async () => {
    const cookieEntered = deferred<void>();
    const releaseCookie = deferred<void>();
    const initialOwner = owner();
    const env = createEntryControllerHarness({
      initialClaimIntent: initialOwner,
    });
    const holder = env.mutationLock.runCookieMutation(async () => {
      cookieEntered.resolve(undefined);
      await releaseCookie.promise;
    });
    await cookieEntered.promise;
    const controller = env.createController();
    const operation = controller.bootstrap();
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    await controller.destroy();

    releaseCookie.resolve(undefined);
    await Promise.all([holder, operation]);

    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.storage.readClaimCookieIntent()).toEqual(initialOwner);
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.rotationCount).toBe(0);
  });

  it("keeps destroy pending on an AbortSignal-ignoring Claim request", async () => {
    const response = deferred<void>();
    const env = createEntryControllerHarness({
      api: { claimWebPairing: vi.fn(() => response.promise) },
    });
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.http.waitForRequest("claimWebPairing");
    const intent = env.storage.readClaimCookieIntent();
    expect(intent).not.toBeNull();

    const destroying = controller.destroy();
    const destroyOutcome = await Promise.race([
      destroying.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 0)
      ),
    ]);
    expect(destroyOutcome).toBe("pending");

    response.resolve(undefined);
    await Promise.all([operation, destroying]);

    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.storage.readClaimCookieIntent()).toEqual(intent);
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.workbench.start).not.toHaveBeenCalled();
  });

  it("keeps Resume marker and locked lifecycle after destroy during Context", async () => {
    const context = deferred<any>();
    const env = createEntryControllerHarness({
      initialMarker: true,
      initialLifecycle: { state: "locked", revision: 1, transitionId: T1 },
      api: { getWebContext: vi.fn(() => context.promise) },
    });
    const controller = env.createController();
    const operation = controller.resume();
    await env.http.waitForRequest("getWebContext");
    const marker = env.storage.readLockMarker(I1);
    const lifecycle = env.storage.readLifecycle(I1);

    const destroying = controller.destroy();
    context.resolve({ context: memberContextFixture() });
    await Promise.all([operation, destroying]);

    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readLifecycle(I1)).toEqual(lifecycle);
    expect(env.api.renewWebSession).not.toHaveBeenCalled();
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(env.channels.posted).toHaveLength(0);
  });

  it("keeps committed Claim activation evidence unchanged after destroy during Context", async () => {
    const context = deferred<any>();
    const env = createEntryControllerHarness({
      initialMarker: true,
      api: { getWebContext: vi.fn(() => context.promise) },
    });
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.http.waitForRequest("getWebContext");
    expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
    expect(env.storage.readClaimCookieIntent()).toBeNull();
    expect(env.pendingClaims.clear).toHaveBeenCalledOnce();
    const marker = env.storage.readLockMarker(I1);
    const lifecycle = env.storage.readLifecycle(I1);

    const destroying = controller.destroy();
    context.resolve({ context: memberContextFixture() });
    await Promise.all([operation, destroying]);

    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readLifecycle(I1)).toEqual(lifecycle);
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(env.channels.posted).toHaveLength(0);
  });

  it("keeps a queued Claim intent untouched after destroy before Product drain", async () => {
    const env = createEntryControllerHarness({ initialMarker: true });
    const lease = await env.mutationLock.acquireProductFlight(I1);
    const controller = env.createController();
    const operation = controller.claim(pendingClaimFixture());
    await env.locks.waitForEvent(
      "request",
      `family-ai-member-product-flight:${I1}`,
      "exclusive",
    );
    const intent = env.storage.readClaimCookieIntent();
    expect(intent).not.toBeNull();

    const destroying = controller.destroy();
    const newerLifecycle = env.storage.advanceLifecycle(I1, "active", T2);
    const afterDestroy = {
      storage: env.localStorage.dump(),
      posted: env.channels.posted.length,
      views: env.view.states.length,
    };
    await lease.release();
    await Promise.all([operation, destroying]);

    expect(env.api.claimWebPairing).not.toHaveBeenCalled();
    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.pendingClaims.clear).not.toHaveBeenCalled();
    expect(env.storage.readClaimCookieIntent()).toEqual(intent);
    expect(env.storage.readLifecycle(I1)).toEqual(newerLifecycle);
    expect(env.localStorage.dump()).toEqual(afterDestroy.storage);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
  });

  it("keeps queued Bootstrap inert when destroy wins before Cookie entry", async () => {
    const cookieEntered = deferred<void>();
    const releaseCookie = deferred<void>();
    const env = createEntryControllerHarness();
    const holder = env.mutationLock.runCookieMutation(async () => {
      cookieEntered.resolve(undefined);
      await releaseCookie.promise;
    });
    await cookieEntered.promise;
    const controller = env.createController();
    const operation = controller.bootstrap();
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );

    await controller.destroy();
    const afterDestroy = {
      storage: env.localStorage.dump(),
      posted: env.channels.posted.length,
      views: env.view.states.length,
    };
    releaseCookie.resolve(undefined);
    await Promise.all([holder, operation]);

    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.api.renewWebSession).not.toHaveBeenCalled();
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(env.localStorage.dump()).toEqual(afterDestroy.storage);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
  });

  it("keeps a queued active receiver inert after destroy", async () => {
    const cookieEntered = deferred<void>();
    const releaseCookie = deferred<void>();
    const env = createEntryControllerHarness({
      initialLifecycle: { state: "active", revision: 1, transitionId: T1 },
    });
    const holder = env.mutationLock.runCookieMutation(async () => {
      cookieEntered.resolve(undefined);
      await releaseCookie.promise;
    });
    await cookieEntered.promise;
    const controller = env.createController();
    env.channels.dispatch({
      protocolVersion: 2,
      type: "session-restored",
      installationId: I1,
      transitionId: T1,
      revision: 1,
      occurredAt: FIXED,
    });
    await env.channels.whenIdle();
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );

    await controller.destroy();
    const afterDestroy = {
      storage: env.localStorage.dump(),
      posted: env.channels.posted.length,
      views: env.view.states.length,
    };
    releaseCookie.resolve(undefined);
    await holder;
    await controller.whenIdle();

    expect(env.api.getWebContext).not.toHaveBeenCalled();
    expect(env.api.renewWebSession).not.toHaveBeenCalled();
    expect(env.workbench.start).not.toHaveBeenCalled();
    expect(env.localStorage.dump()).toEqual(afterDestroy.storage);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
  });
});

describe("Member Entry second-review cleanup RED inventory", () => {
  it("stops Revoke after a pending identity delete settles post-destroy", async () => {
    const deletionStarted = deferred<void>();
    const deletion = deferred<void>();
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      cacheLifecycle: {
        deleteIdentity: vi.fn(() => {
          deletionStarted.resolve(undefined);
          return deletion.promise;
        }),
      },
    });
    const controller = env.createController();
    const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
    await deletionStarted.promise;
    const marker = env.storage.readLockMarker(I1);
    const target = env.storage.readCleanupTombstone(I1);
    const lifecycle = env.storage.readLifecycle(I1);
    const pointer = env.storage.readIdentityPointer(I1);
    expect(target).toMatchObject({
      phase: "deleting",
      cookiesCleared: true,
      identity: IDENTITY,
    });

    await controller.destroy();
    const afterDestroy = {
      posted: env.channels.posted.length,
      views: env.view.states.length,
    };
    deletion.resolve(undefined);
    await operation;

    expect(env.storage.readIdentityPointer(I1)).toEqual(pointer);
    expect(env.storage.readCleanupTombstone(I1)).toEqual(target);
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readLifecycle(I1)).toEqual(lifecycle);
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.rotationCount).toBe(0);
    expect(env.channels.posted).toHaveLength(afterDestroy.posted);
    expect(env.view.states).toHaveLength(afterDestroy.views);
  });

  it("retains Revoke marker and tombstone when destroy wins its queued marker clear", async () => {
    const deletionStarted = deferred<void>();
    const deletion = deferred<void>();
    const markerEntered = deferred<void>();
    const releaseMarker = deferred<void>();
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      cacheLifecycle: {
        deleteIdentity: vi.fn(() => {
          deletionStarted.resolve(undefined);
          return deletion.promise;
        }),
      },
    });
    const controller = env.createController();
    const operation = controller.revoke(entryError("DEVICE_REVOKED"), I1);
    await deletionStarted.promise;
    const marker = env.storage.readLockMarker(I1);

    const holder = env.mutationLock.runMarkerMutation(I1, async () => {
      markerEntered.resolve(undefined);
      await releaseMarker.promise;
    });
    await markerEntered.promise;
    deletion.resolve(undefined);
    await env.locks.waitForEvent(
      "request",
      `family-ai-member-entry-marker:${I1}`,
      "exclusive",
      3,
    );
    const target = env.storage.readCleanupTombstone(I1);
    const lifecycle = env.storage.readLifecycle(I1);
    expect(env.storage.readIdentityPointer(I1)).toBeNull();

    await controller.destroy();
    releaseMarker.resolve(undefined);
    await Promise.all([holder, operation]);

    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readCleanupTombstone(I1)).toEqual(target);
    expect(env.storage.readLifecycle(I1)).toEqual(lifecycle);
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.rotationCount).toBe(0);
  });

  it("cancels authoritative Remove completion after destroy", async () => {
    const response = deferred<void>();
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      api: { revokeWebDevice: vi.fn(() => response.promise) },
    });
    const controller = env.createController();
    const operation = controller.removeDevice();
    await env.http.waitForRequest("revokeWebDevice");
    const marker = env.storage.readLockMarker(I1);
    const pointer = env.storage.readIdentityPointer(I1);
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readLifecycle(I1)).toBeNull();

    await controller.destroy();
    response.resolve(undefined);
    await operation;

    expect(env.api.revokeWebDevice).toHaveBeenCalledOnce();
    expect(env.api.clearWebEntryCookies).not.toHaveBeenCalled();
    expect(env.cacheLifecycle.deleteIdentity).not.toHaveBeenCalled();
    expect(env.storage.readIdentityPointer(I1)).toEqual(pointer);
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readLifecycle(I1)).toBeNull();
    expect(env.storage.readLockMarker(I1)).toEqual(marker);
    expect(env.storage.readInstallationId()).toBe(I1);
    expect(env.rotationCount).toBe(0);
  });

  it("checkpoints one Revoke clear across a monotonic M2 takeover", async () => {
    const clear = deferred<void>();
    const writes: Array<{ actor: "A" | "B"; record: any }> = [];
    const env = createEntryControllerHarness({
      initialIdentity: IDENTITY,
      api: { clearWebEntryCookies: vi.fn(() => clear.promise) },
    });
    const observeWrites = (baseStorage: any, actor: "A" | "B") =>
      new Proxy(baseStorage, {
        get(target, property, receiver) {
          if (property !== "writeCleanupTombstone") {
            return Reflect.get(target, property, receiver);
          }
          return (installationId: string, record: any) => {
            const written = target.writeCleanupTombstone(
              installationId,
              record,
            );
            writes.push({ actor, record: structuredClone(written) });
            return written;
          };
        },
      });
    const first = env.createController({
      storage: observeWrites(env.storage, "A"),
    });
    const firstOperation = first.revoke(entryError("DEVICE_REVOKED"), I1);
    await env.http.waitForRequest("clearWebEntryCookies");
    const markerM1 = env.storage.readLockMarker(I1);
    expect(env.storage.readCleanupTombstone(I1)).toMatchObject({
      phase: "closing",
      cookiesCleared: false,
    });

    const peer = env.createTab({
      now: () => new Date("2026-07-25T09:00:01.000Z"),
    });
    const second = peer.createController({
      storage: observeWrites(peer.storage, "B"),
    });
    const secondOperation = second.revoke(entryError("DEVICE_REVOKED"), I1);
    await env.locks.waitForEvent(
      "request",
      "family-ai-member-cookie-mutation",
      "exclusive",
      2,
    );
    const markerM2 = env.storage.readLockMarker(I1);
    expect(markerM2).not.toEqual(markerM1);

    clear.resolve(undefined);
    await Promise.all([firstOperation, secondOperation]);

    expect(
      env.api.clearWebEntryCookies.mock.calls.length +
        peer.api.clearWebEntryCookies.mock.calls.length,
    ).toBe(1);
    expect(writes).toContainEqual({
      actor: "A",
      record: expect.objectContaining({
        phase: "closing",
        cookiesCleared: true,
      }),
    });
    expect(
      env.cacheLifecycle.deleteIdentity.mock.calls.length +
        peer.cacheLifecycle.deleteIdentity.mock.calls.length,
    ).toBe(1);
    expect(env.storage.readLockMarker(I1)).toBeNull();
    expect(env.storage.readCleanupTombstone(I1)).toBeNull();
    expect(env.storage.readIdentityPointer(I1)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(I2);
    expect(env.rotationCount + peer.rotationCount).toBe(1);
  });
});

describe("Member Entry second-review rejected Claim RED inventory", () => {
  it.each(["retained", "replaced"])(
    "rejects a rejected Claim intent clear whose backing is %s",
    async (mode) => {
      const rejected = Object.assign(entryError("PAIRING_INVALID"), {
        claimOutcome: "rejected",
      });
      const env = createEntryControllerHarness({
        api: { claimWebPairing: vi.fn(async () => { throw rejected; }) },
      });
      const baseStorage = env.storage;
      const replacement = owner(I1, T2);
      const lyingStorage = new Proxy(baseStorage, {
        get(target, property, receiver) {
          if (property !== "clearClaimCookieIntent") {
            return Reflect.get(target, property, receiver);
          }
          return () => {
            if (mode === "replaced") {
              env.localStorage.setItem(
                "family-ai-member-claim-cookie-intent",
                JSON.stringify(replacement),
              );
            }
            return true;
          };
        },
      });
      const controller = env.createController({ storage: lyingStorage });

      await controller.claim(pendingClaimFixture());

      expect(env.api.claimWebPairing).toHaveBeenCalledOnce();
      expect(env.storage.readClaimCookieIntent()).toEqual(
        mode === "replaced"
          ? replacement
          : expect.objectContaining({ installationId: I1 }),
      );
      expect(env.pendingClaims.clear).not.toHaveBeenCalled();
      expect(env.api.getWebContext).not.toHaveBeenCalled();
      expect(env.storage.readLifecycle(I1)).toBeNull();
      expect(env.workbench.start).not.toHaveBeenCalled();
      expect(controller.getState()).toMatchObject({
        name: "recoverable_error",
        code: "ENTRY_CLAIM_INTENT_CHANGED",
      });
    },
  );
});
