import {
  CLAIM_COOKIE_INTENT_KEY,
  COOKIE_CLEAR_PENDING_KEY,
  INSTALLATION_KEY,
  installationIdForStorageKey
} from "./entry-storage.js";

const CHANNEL_NAME = "family-ai-member-entry-lifecycle";
const WAKE_TYPES = new Set([
  "session-locked",
  "session-restored",
  "device-revoke-preparing",
  "device-revoke-complete"
]);

const PUBLIC_ERRORS = Object.freeze({
  ENTRY_MUTATION_LOCK_UNAVAILABLE: "当前浏览器不支持安全入口协调。",
  ENTRY_TOMBSTONE_INCONSISTENT: "入口清理状态不一致，请重试。",
  ENTRY_LIFECYCLE_MISSING: "入口状态缺失，请重试。",
  ENTRY_LIFECYCLE_CHANGED_DURING_START: "入口状态已经变化，请重试。",
  ENTRY_INSTALLATION_CHANGED: "浏览器入口已经变化，请重新配对。",
  ENTRY_COOKIE_CLEAR_PENDING: "浏览器入口正在安全清理，请稍候。",
  ENTRY_COOKIE_OWNER_CHANGED: "浏览器入口清理状态已经变化，请重试。",
  ENTRY_CLAIM_INTENT_CHANGED: "配对状态已经变化，请重试。",
  ENTRY_MARKER_CHANGED: "入口锁定状态已经变化，请重试。",
  ENTRY_IDENTITY_POINTER_RETAINED: "本地身份清理尚未完成，请重试。",
  ENTRY_CLEANUP_CHECKPOINT_FAILED: "入口清理检查点未完成，请重试。",
  REVOKE_COOKIE_CLEAR_FAILED: "无法清除浏览器入口，请重试。",
  MEMBER_CACHE_DELETE_BLOCKED: "本地数据正在被其他页面使用，请关闭后重试。",
  PAIRING_FRAGMENT_INVALID: "配对链接无效，请重新获取。",
  PAIRING_OUTCOME_UNKNOWN: "配对结果未确认，浏览器入口已安全清理，请重试。",
  GATEWAY_UNAVAILABLE: "服务暂时不可用，请重试。"
});

function publicError(code) {
  const safeCode = Object.hasOwn(PUBLIC_ERRORS, code)
    ? code
    : "GATEWAY_UNAVAILABLE";
  return { code: safeCode, message: PUBLIC_ERRORS[safeCode] };
}

function localEntryError(code, message = "入口状态已经变化，请重试。") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotLifecycle(record) {
  return {
    revision: record?.revision ?? 0,
    state: record?.state ?? null,
    transitionId: record?.transitionId ?? null
  };
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validLifecycleWake(message) {
  return exactObject(message, [
    "protocolVersion",
    "type",
    "installationId",
    "transitionId",
    "revision",
    "occurredAt"
  ]) &&
    message.protocolVersion === 2 &&
    WAKE_TYPES.has(message.type) &&
    typeof message.installationId === "string" &&
    typeof message.transitionId === "string" &&
    Number.isSafeInteger(message.revision) &&
    message.revision > 0 &&
    typeof message.occurredAt === "string";
}

function isSessionError(error) {
  return error?.code === "ENTRY_SESSION_INVALID" ||
    error?.code === "ENTRY_SESSION_EXPIRED";
}

function isInvalidatingError(error) {
  return error?.code === "DEVICE_REVOKED" ||
    error?.code === "DEVICE_AUTH_INVALID";
}

export function createEntryController(input) {
  const {
    api,
    storage,
    mutationLock,
    cacheLifecycle,
    workbench,
    pendingClaims,
    deviceDescriptor,
    BroadcastChannelClass = globalThis.BroadcastChannel,
    AbortControllerClass = globalThis.AbortController,
    eventTarget = globalThis,
    now = () => new Date(),
    uuid = () => globalThis.crypto.randomUUID(),
    onViewState = () => {}
  } = input;

  let state = {
    name: "unpaired",
    busy: false,
    code: null,
    message: null,
    showResume: false,
    showRetry: false,
    cleanupBlocked: false,
    serverLogoutConfirmed: null
  };
  let retryAction = null;
  let activeProductInstallationId = null;
  let activeClaimAbort = null;
  let activeClaimPromise = null;
  let destroyed = false;
  let destroyPromise = null;
  let receiverLane = Promise.resolve();
  const activeRevokes = new Map();
  const channel = typeof BroadcastChannelClass === "function"
    ? new BroadcastChannelClass(CHANNEL_NAME)
    : null;
  const initialInstallationId = storage.readInstallationId();
  const knownInstallationIds = new Set(initialInstallationId ? [initialInstallationId] : []);
  const lastAppliedRevisions = new Map();
  if (initialInstallationId) {
    lastAppliedRevisions.set(
      initialInstallationId,
      storage.readLifecycle(initialInstallationId)?.revision ?? 0
    );
  }

  function transition(name, patch = {}, nextRetry = null) {
    if (destroyed) return;
    const visibleError = patch.code ? publicError(patch.code) : null;
    retryAction = nextRetry;
    state = {
      name,
      busy: patch.busy === true,
      code: visibleError?.code ?? null,
      message: visibleError?.message ?? null,
      showResume: typeof patch.showResume === "boolean"
        ? patch.showResume
        : name === "locked",
      showRetry: typeof patch.showRetry === "boolean"
        ? patch.showRetry
        : name === "recoverable_error" || name === "revoked",
      cleanupBlocked: patch.cleanupBlocked === true,
      serverLogoutConfirmed: typeof patch.serverLogoutConfirmed === "boolean"
        ? patch.serverLogoutConfirmed
        : null
    };
    onViewState(structuredClone(state));
  }

  function getState() {
    return structuredClone(state);
  }

  function lifecycleMatches(installationId, expected) {
    return sameRecord(
      snapshotLifecycle(storage.readLifecycle(installationId)),
      expected
    );
  }

  function publish(type, lifecycle, installationId) {
    if (destroyed || !channel) return;
    channel.postMessage({
      protocolVersion: 2,
      type,
      installationId,
      transitionId: lifecycle.transitionId,
      revision: lifecycle.revision,
      occurredAt: now().toISOString()
    });
  }

  function hasInstallationEvidence(installationId) {
    if (storage.readInstallationId() === installationId) {
      knownInstallationIds.add(installationId);
      return true;
    }
    return knownInstallationIds.has(installationId) || Boolean(
      storage.readLifecycle(installationId) ||
      storage.readLockMarker(installationId) ||
      storage.readCleanupTombstone(installationId) ||
      storage.readIdentityPointer(installationId)
    );
  }

  async function writeSupportedMarker(installationId) {
    return mutationLock.runMarkerMutation(
      installationId,
      () => {
        if (
          destroyed ||
          storage.readInstallationId() !== installationId
        ) return null;
        knownInstallationIds.add(installationId);
        return storage.writeLockMarkerLocked(installationId);
      }
    );
  }

  async function clearSupportedMarker(installationId, expectedMarker) {
    return mutationLock.runMarkerMutation(
      installationId,
      () => storage.clearLockMarkerLocked(installationId, expectedMarker)
    );
  }

  async function stopTrackedWorkbench() {
    activeProductInstallationId = null;
    await workbench.stop();
  }

  async function stopForLockedState() {
    await stopTrackedWorkbench();
  }

  function assertStartable(installationId, expectedLifecycle) {
    if (destroyed) throw localEntryError("ENTRY_CONTROLLER_DESTROYED");
    if (storage.readInstallationId() !== installationId) {
      throw localEntryError("ENTRY_INSTALLATION_CHANGED");
    }
    if (!lifecycleMatches(installationId, expectedLifecycle)) {
      throw localEntryError("ENTRY_LIFECYCLE_CHANGED_DURING_START");
    }
    if (storage.readClaimCookieIntent() || storage.readCookieClearPending()) {
      throw localEntryError("ENTRY_COOKIE_CLEAR_PENDING");
    }
    const tombstone = storage.readCleanupTombstone(installationId);
    const lifecycle = storage.readLifecycle(installationId);
    if (tombstone || lifecycle?.state === "revoked") {
      throw localEntryError("DEVICE_REVOKED");
    }
    if (
      storage.readLockMarker(installationId) ||
      lifecycle?.state === "locked"
    ) {
      throw localEntryError("ENTRY_LOCKED_DURING_START");
    }
  }

  async function startWithContext(context, installationId, expectedLifecycle) {
    const guard = () => assertStartable(installationId, expectedLifecycle);
    try {
      guard();
      const started = await workbench.start(context, installationId, guard);
      if (!started) return false;
      guard();
      activeProductInstallationId = installationId;
      return true;
    } catch (error) {
      await stopTrackedWorkbench();
      if (
        error?.code === "ENTRY_LIFECYCLE_CHANGED_DURING_START" ||
        error?.code === "ENTRY_INSTALLATION_CHANGED" ||
        error?.code === "ENTRY_CONTROLLER_DESTROYED"
      ) return false;
      throw error;
    }
  }

  async function runCookieAndEntry(installationId, operation) {
    if (!mutationLock.available) {
      throw localEntryError("ENTRY_MUTATION_LOCK_UNAVAILABLE");
    }
    return mutationLock.runCookieMutation(
      () => mutationLock.run(installationId, operation)
    );
  }

  async function runCookieEntryAndDrain(installationId, operation) {
    if (!mutationLock.available) {
      throw localEntryError("ENTRY_MUTATION_LOCK_UNAVAILABLE");
    }
    return mutationLock.runCookieMutation(
      () => mutationLock.run(
        installationId,
        () => mutationLock.runProductDrain(installationId, operation)
      )
    );
  }

  function currentCookieOwner() {
    const intent = storage.readClaimCookieIntent();
    const signal = storage.readCookieClearPending();
    return intent
      ? { kind: "claim-intent", record: intent }
      : signal
        ? { kind: "cookie-clear", record: signal }
        : null;
  }

  function clearCookieOwner(kind, transitionId) {
    return kind === "claim-intent"
      ? storage.clearClaimCookieIntent(transitionId)
      : storage.clearCookieClearPending(transitionId);
  }

  async function clearCookiesForRevoke() {
    try {
      await api.clearWebEntryCookies();
    } catch (cause) {
      const error = localEntryError(
        "REVOKE_COOKIE_CLEAR_FAILED",
        "无法清除浏览器入口，请重试。"
      );
      error.cause = cause;
      throw error;
    }
  }

  async function retryOriginCookieCleanup(kind, expectedTransitionId) {
    const read = () => kind === "claim-intent"
      ? storage.readClaimCookieIntent()
      : storage.readCookieClearPending();
    if (!mutationLock.available) {
      transition("recoverable_error", {
        code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
        message: "请使用支持 Web Locks 的浏览器完成安全入口清理。",
        showRetry: true
      }, () => retryOriginCookieCleanup(kind, expectedTransitionId));
      return "blocked";
    }
    try {
      const before = read();
      if (!before || before.transitionId !== expectedTransitionId) return "gone";
      await stopTrackedWorkbench();
      let cleared = false;
      await mutationLock.runCookieMutation(async () => {
        const owner = read();
        if (!owner || owner.transitionId !== expectedTransitionId) return;
        await mutationLock.run(owner.installationId, () =>
          mutationLock.runProductDrain(owner.installationId, async () => {
            const latest = read();
            if (!latest || latest.transitionId !== expectedTransitionId) return;
            await clearCookiesForRevoke();
            cleared = clearCookieOwner(kind, expectedTransitionId);
          })
        );
      });
      if (cleared) {
        transition("unpaired", { code: "ENTRY_INSTALLATION_CHANGED" });
        return "cleared";
      }
      if (!read()) return "gone";
      transition("recoverable_error", {
        code: "ENTRY_COOKIE_OWNER_CHANGED",
        message: "入口 Cookie 清理所有者已经变化，请重试。",
        showRetry: true
      }, () => retryOriginCookieCleanup(kind, expectedTransitionId));
      return "blocked";
    } catch (error) {
      const visible = error?.code === "REVOKE_COOKIE_CLEAR_FAILED"
        ? error
        : Object.assign(localEntryError(
          "REVOKE_COOKIE_CLEAR_FAILED",
          "无法清除已失配的浏览器入口，请重试。"
        ), { cause: error });
      transition("recoverable_error", {
        code: visible.code,
        message: visible.message,
        showRetry: true
      }, () => retryOriginCookieCleanup(kind, expectedTransitionId));
      return "blocked";
    }
  }

  function persistClaimCookieIntent(installationId) {
    const existing = storage.readClaimCookieIntent();
    if (existing) return existing;
    return storage.writeClaimCookieIntent({
      protocolVersion: 2,
      transitionId: uuid(),
      installationId,
      createdAt: now().toISOString()
    });
  }

  async function prepareClaimedActivationLocked(
    context,
    installationId,
    activationState
  ) {
    if (storage.readInstallationId() !== installationId) {
      throw localEntryError("ENTRY_INSTALLATION_CHANGED");
    }
    const marker = storage.readLockMarker(installationId);
    if (!sameRecord(marker, activationState.expectedMarker)) {
      await stopForLockedState();
      transition("locked", { showResume: true });
      return false;
    }
    const lifecycle = storage.readLifecycle(installationId);
    if (
      storage.readCleanupTombstone(installationId) ||
      lifecycle?.state === "revoked"
    ) throw localEntryError("DEVICE_REVOKED");
    if (activationState.committedLifecycle) {
      if (
        !lifecycleMatches(installationId, activationState.committedLifecycle) ||
        storage.readLockMarker(installationId)
      ) throw localEntryError("ENTRY_LIFECYCLE_CHANGED_DURING_START");
      return {
        context,
        installationId,
        expectedLifecycle: activationState.committedLifecycle
      };
    }
    if (marker) {
      const removed = await clearSupportedMarker(installationId, marker);
      if (!removed || storage.readLockMarker(installationId)) {
        await stopForLockedState();
        transition("locked", { showResume: true });
        return false;
      }
      activationState.expectedMarker = null;
    }
    const active = storage.advanceLifecycle(
      installationId,
      "active",
      uuid()
    );
    activationState.committedLifecycle = snapshotLifecycle(active);
    publish("session-restored", active, installationId);
    return {
      context,
      installationId,
      expectedLifecycle: activationState.committedLifecycle
    };
  }

  async function retryCommittedClaim(installationId, activationState) {
    let ticket = null;
    try {
      if (!activationState.pendingCleared) {
        pendingClaims.clear();
        activationState.pendingCleared = true;
      }
      await stopTrackedWorkbench();
      await runCookieAndEntry(installationId, async () => {
        if (destroyed || storage.readInstallationId() !== installationId) {
          throw localEntryError("ENTRY_INSTALLATION_CHANGED");
        }
        if (currentCookieOwner()) {
          throw localEntryError("ENTRY_COOKIE_CLEAR_PENDING");
        }
        const response = await api.getWebContext();
        ticket = await prepareClaimedActivationLocked(
          response.context,
          installationId,
          activationState
        );
      });
      if (ticket) {
        const started = await startWithContext(
          ticket.context,
          ticket.installationId,
          ticket.expectedLifecycle
        );
        if (started) transition("active");
      }
    } catch (error) {
      await handleCommittedClaimFailure(error, installationId, activationState);
    }
  }

  async function handleCommittedClaimFailure(error, installationId, activationState) {
    if (storage.readInstallationId() !== installationId) return;
    if (error?.code === "ENTRY_COOKIE_CLEAR_PENDING") {
      const pending = currentCookieOwner();
      if (pending) {
        await retryOriginCookieCleanup(
          pending.kind,
          pending.record.transitionId
        );
      }
      return;
    }
    if (isInvalidatingError(error)) {
      await revoke(error, installationId);
      return;
    }
    if (error?.code === "ENTRY_LOCKED_DURING_START") {
      await stopForLockedState();
      transition("locked", { showResume: true });
      return;
    }
    if (isSessionError(error)) {
      await recoverAuthenticatedSession(installationId);
      return;
    }
    transition("recoverable_error", {
      code: error?.code ?? "GATEWAY_UNAVAILABLE",
      message: error?.message,
      showRetry: true
    }, () => retryCommittedClaim(installationId, activationState));
  }

  function claim(pendingClaim, suppliedActivationState) {
    if (activeClaimPromise) return activeClaimPromise;
    const activationState = suppliedActivationState ?? {
      expectedMarker: storage.readLockMarker(pendingClaim.installationId),
      committedLifecycle: null,
      pendingCleared: false
    };
    const operation = claimOnce(pendingClaim, activationState);
    activeClaimPromise = operation;
    operation.then(
      () => { if (activeClaimPromise === operation) activeClaimPromise = null; },
      () => { if (activeClaimPromise === operation) activeClaimPromise = null; }
    );
    return operation;
  }

  async function claimOnce(pendingClaim, activationState) {
    const installationId = pendingClaim.installationId;
    if (storage.readInstallationId() !== installationId) {
      pendingClaims.clear();
      transition("unpaired", { code: "ENTRY_INSTALLATION_CHANGED" });
      return;
    }
    if (!mutationLock.available) {
      transition("recoverable_error", {
        code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
        message: "请使用支持 Web Locks 的浏览器完成安全配对。",
        showRetry: true
      }, () => claim(pendingClaim, activationState));
      return;
    }
    transition("pairing", { busy: true });
    const abort = new AbortControllerClass();
    activeClaimAbort = abort;
    let committed = false;
    let uncertain = null;
    let ticket = null;
    try {
      await stopTrackedWorkbench();
      await runCookieAndEntry(installationId, async () => {
        if (
          destroyed || abort.signal.aborted ||
          storage.readInstallationId() !== installationId
        ) {
          if (destroyed || abort.signal.aborted) return;
          throw localEntryError("ENTRY_INSTALLATION_CHANGED");
        }
        if (
          currentCookieOwner() ||
          storage.readCleanupTombstone(installationId) ||
          storage.readLifecycle(installationId)?.state === "revoked"
        ) throw localEntryError("ENTRY_COOKIE_CLEAR_PENDING");
        const intent = persistClaimCookieIntent(installationId);
        if (destroyed || abort.signal.aborted) return;
        await mutationLock.runProductDrain(installationId, async () => {
          if (
            destroyed || abort.signal.aborted ||
            storage.readInstallationId() !== installationId ||
            storage.readClaimCookieIntent()?.transitionId !== intent.transitionId
          ) return;
          try {
            await api.claimWebPairing({
              ...pendingClaim,
              device: deviceDescriptor
            }, { signal: abort.signal });
          } catch (error) {
            if (error?.claimOutcome === "rejected") {
              if (!storage.clearClaimCookieIntent(intent.transitionId)) {
                throw localEntryError("ENTRY_CLAIM_INTENT_CHANGED");
              }
            } else {
              uncertain = intent;
            }
            throw error;
          }
          committed = true;
          if (!storage.clearClaimCookieIntent(intent.transitionId)) {
            throw localEntryError("ENTRY_CLAIM_INTENT_CHANGED");
          }
          pendingClaims.clear();
          activationState.pendingCleared = true;
          if (destroyed || abort.signal.aborted) return;
          const response = await api.getWebContext();
          ticket = await prepareClaimedActivationLocked(
            response.context,
            installationId,
            activationState
          );
        });
      });
      if (ticket) {
        const started = await startWithContext(
          ticket.context,
          ticket.installationId,
          ticket.expectedLifecycle
        );
        if (started) transition("active");
      }
    } catch (error) {
      if (destroyed && uncertain) {
        await stopTrackedWorkbench();
        return;
      }
      if (
        uncertain &&
        storage.readClaimCookieIntent()?.transitionId === uncertain.transitionId
      ) {
        await retryOriginCookieCleanup("claim-intent", uncertain.transitionId);
        if (storage.readClaimCookieIntent()) return;
      }
      if (storage.readInstallationId() !== installationId) {
        pendingClaims.clear();
        transition("unpaired", { code: "ENTRY_INSTALLATION_CHANGED" });
        return;
      }
      if (committed) {
        await handleCommittedClaimFailure(error, installationId, activationState);
        return;
      }
      if (error?.code === "ENTRY_COOKIE_CLEAR_PENDING") {
        const pending = currentCookieOwner();
        if (pending) {
          await retryOriginCookieCleanup(pending.kind, pending.record.transitionId);
        } else if (
          storage.readCleanupTombstone(installationId) ||
          storage.readLifecycle(installationId)?.state === "revoked"
        ) {
          await retryCleanup(installationId);
        }
        return;
      }
      if (error?.claimOutcome === "unknown") {
        transition("recoverable_error", {
          code: error?.code ?? "PAIRING_OUTCOME_UNKNOWN",
          message: "配对结果未确认，浏览器入口已安全清理，请重试。",
          showRetry: true
        }, () => claim(pendingClaim, activationState));
        return;
      }
      if (error?.code === "DEVICE_REVOKED") {
        pendingClaims.clear();
        await revoke(error, installationId);
        return;
      }
      if (pendingClaims.isTerminalError(error)) {
        pendingClaims.clear();
        transition("unpaired", { code: error?.code, message: error?.message });
        return;
      }
      if (!pendingClaims.shouldRetain(error)) {
        pendingClaims.clear();
        transition("unpaired", {
          code: error?.code ?? "PAIRING_FAILED",
          message: error?.message
        });
        return;
      }
      transition("recoverable_error", {
        code: error?.code ?? "GATEWAY_UNAVAILABLE",
        message: error?.message,
        showRetry: true
      }, () => claim(pendingClaim, activationState));
    } finally {
      if (activeClaimAbort === abort) activeClaimAbort = null;
    }
  }

  async function recoverAuthenticatedSession(installationId, explicit = false) {
    if (destroyed || storage.readInstallationId() !== installationId) return;
    if (!mutationLock.available) {
      await stopForLockedState();
      transition("locked", {
        code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
        showResume: true,
        showRetry: true
      });
      return;
    }
    let ownedMarker = storage.readLockMarker(installationId);
    if (!explicit) {
      if (ownedMarker) {
        await stopForLockedState();
        transition("locked", { showResume: true });
        return;
      }
      ownedMarker = await writeSupportedMarker(installationId);
      if (!ownedMarker) return;
    }
    await stopTrackedWorkbench();
    let ticket = null;
    try {
      await runCookieEntryAndDrain(installationId, async () => {
        if (destroyed || storage.readInstallationId() !== installationId) return;
        const capturedLifecycle = snapshotLifecycle(
          storage.readLifecycle(installationId)
        );
        const capturedMarker = storage.readLockMarker(installationId);
        if (!explicit && !sameRecord(capturedMarker, ownedMarker)) return;
        const stillCurrent = () =>
          !destroyed &&
          storage.readInstallationId() === installationId &&
          sameRecord(storage.readLockMarker(installationId), capturedMarker) &&
          lifecycleMatches(installationId, capturedLifecycle) &&
          !storage.readCleanupTombstone(installationId) &&
          !currentCookieOwner();
        if (!stillCurrent()) return;
        let response;
        try {
          response = await api.getWebContext();
        } catch (error) {
          if (!isSessionError(error)) throw error;
          if (!stillCurrent()) return;
          await api.renewWebSession();
          if (!stillCurrent()) return;
          response = await api.getWebContext();
        }
        const latestMarker = storage.readLockMarker(installationId);
        const latestLifecycle = storage.readLifecycle(installationId);
        if (
          storage.readInstallationId() !== installationId ||
          storage.readCleanupTombstone(installationId) ||
          latestLifecycle?.state === "revoked" ||
          !sameRecord(latestMarker, capturedMarker) ||
          !lifecycleMatches(installationId, capturedLifecycle)
        ) return;
        if (!latestMarker) {
          if (latestLifecycle?.state === "active") {
            ticket = {
              context: response.context,
              installationId,
              expectedLifecycle: snapshotLifecycle(latestLifecycle)
            };
          }
          return;
        }
        const removed = await clearSupportedMarker(installationId, latestMarker);
        if (!removed || storage.readLockMarker(installationId)) return;
        const active = storage.advanceLifecycle(
          installationId,
          "active",
          uuid()
        );
        publish("session-restored", active, installationId);
        ticket = {
          context: response.context,
          installationId,
          expectedLifecycle: snapshotLifecycle(active)
        };
      });
      if (!ticket) {
        await stopForLockedState();
        transition("locked", { showResume: true });
        return;
      }
      const started = await startWithContext(
        ticket.context,
        ticket.installationId,
        ticket.expectedLifecycle
      );
      if (started) transition("active");
    } catch (error) {
      if (isInvalidatingError(error)) {
        await revoke(error, installationId);
      } else {
        await stopForLockedState();
        transition(explicit ? "locked" : "recoverable_error", {
          code: error?.code ?? "GATEWAY_UNAVAILABLE",
          message: error?.message,
          showResume: true,
          showRetry: true
        }, () => recoverAuthenticatedSession(installationId, explicit));
      }
    }
  }

  async function resume() {
    const installationId = storage.readInstallationId();
    if (!installationId) return;
    if (!mutationLock.available) {
      transition("locked", {
        code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
        showResume: true,
        showRetry: true
      });
      return;
    }
    await recoverAuthenticatedSession(installationId, true);
  }

  async function logout() {
    const installationId = storage.readInstallationId();
    if (!installationId) return;
    let marker;
    if (mutationLock.available) {
      marker = await writeSupportedMarker(installationId);
      if (!marker) return;
    } else {
      marker = storage.ensureStickyLockMarker(installationId);
    }
    await stopForLockedState();
    transition("locked", { showResume: true });
    if (!mutationLock.available) {
      try {
        if (
          storage.readInstallationId() !== installationId ||
          !sameRecord(storage.readLockMarker(installationId), marker)
        ) return;
        await api.logoutWebSession();
        transition("locked", {
          showResume: true,
          serverLogoutConfirmed: true
        });
      } catch (error) {
        transition("locked", {
          code: error?.code ?? "GATEWAY_UNAVAILABLE",
          message: error?.message,
          showResume: true,
          showRetry: true,
          serverLogoutConfirmed: false
        }, logout);
      }
      return;
    }
    let lockedLifecycle = null;
    try {
      await runCookieEntryAndDrain(installationId, async () => {
        if (
          storage.readInstallationId() !== installationId ||
          !sameRecord(storage.readLockMarker(installationId), marker)
        ) return;
        lockedLifecycle = storage.advanceLifecycle(
          installationId,
          "locked",
          uuid()
        );
        publish("session-locked", lockedLifecycle, installationId);
        if (
          destroyed ||
          storage.readInstallationId() !== installationId ||
          !sameRecord(storage.readLockMarker(installationId), marker) ||
          !lifecycleMatches(
            installationId,
            snapshotLifecycle(lockedLifecycle)
          ) ||
          storage.readCleanupTombstone(installationId) || currentCookieOwner()
        ) return;
        await api.logoutWebSession();
      });
      if (
        lockedLifecycle &&
        lifecycleMatches(installationId, snapshotLifecycle(lockedLifecycle))
      ) {
        transition("locked", {
          showResume: true,
          serverLogoutConfirmed: true
        });
      }
    } catch (error) {
      await stopForLockedState();
      transition("locked", {
        code: error?.code ?? "GATEWAY_UNAVAILABLE",
        message: error?.message,
        showResume: true,
        showRetry: true,
        serverLogoutConfirmed: false
      }, logout);
    }
  }

  function ensureTargetTombstoneLocked(installationId, transitionId = uuid()) {
    const current = storage.readInstallationId();
    let currentTombstone = storage.readCleanupTombstone(installationId);
    if (current !== installationId && !currentTombstone) return null;
    if (
      current !== installationId &&
      currentTombstone &&
      !currentTombstone.cookiesCleared
    ) throw localEntryError("ENTRY_TOMBSTONE_INCONSISTENT");
    if (!currentTombstone) {
      currentTombstone = storage.writeCleanupTombstone(installationId, {
        protocolVersion: 2,
        transitionId,
        identity: null,
        phase: "closing",
        cookiesCleared: false
      });
    }
    const lifecycle = storage.readLifecycle(installationId);
    if (lifecycle?.state !== "revoked") {
      const revoked = storage.advanceLifecycle(
        installationId,
        "revoked",
        currentTombstone.transitionId
      );
      publish("device-revoke-preparing", revoked, installationId);
    }
    return currentTombstone;
  }

  async function finishOriginOwnerWhileCookieLocked(validateTarget = () => true) {
    const pending = currentCookieOwner();
    if (!pending) return false;
    const { kind, record } = pending;
    let cleared = false;
    await mutationLock.run(record.installationId, () =>
      mutationLock.runProductDrain(record.installationId, async () => {
        const latest = currentCookieOwner();
        if (
          !latest || latest.kind !== kind ||
          latest.record.transitionId !== record.transitionId
        ) return;
        if (!validateTarget()) return;
        await clearCookiesForRevoke();
        cleared = clearCookieOwner(kind, record.transitionId);
        if (!cleared) throw localEntryError("ENTRY_COOKIE_OWNER_CHANGED");
      })
    );
    return cleared;
  }

  async function revokeLocked(
    installationId,
    {
      cookiesAlreadyCleared = false,
      expectedMarker = storage.readLockMarker(installationId)
    } = {}
  ) {
    return mutationLock.runCacheOpen(installationId, async () => {
      let cleanup = storage.readCleanupTombstone(installationId);
      if (!cleanup) return null;
      if (
        storage.readInstallationId() !== installationId &&
        !cleanup.cookiesCleared
      ) throw localEntryError("ENTRY_TOMBSTONE_INCONSISTENT");
      if (!cleanup.cookiesCleared) {
        if (!cookiesAlreadyCleared) {
          if (
            storage.readInstallationId() !== installationId ||
            !sameRecord(storage.readCleanupTombstone(installationId), cleanup) ||
            !sameRecord(storage.readLockMarker(installationId), expectedMarker)
          ) throw localEntryError("ENTRY_CLEANUP_CHECKPOINT_FAILED");
          await clearCookiesForRevoke();
        }
        const clearedCheckpoint = {
          ...cleanup,
          cookiesCleared: true
        };
        cleanup = storage.writeCleanupTombstone(
          installationId,
          clearedCheckpoint
        );
        if (!sameRecord(storage.readCleanupTombstone(installationId), cleanup)) {
          throw localEntryError("ENTRY_CLEANUP_CHECKPOINT_FAILED");
        }
      }
      for (;;) {
        const pointer = storage.readIdentityPointer(installationId);
        if (!pointer) break;
        const identity = {
          familyRef: pointer.familyRef,
          personRef: pointer.personRef,
          deviceRef: pointer.deviceRef
        };
        const deletingCheckpoint = {
          ...cleanup,
          phase: "deleting",
          identity,
          cookiesCleared: true
        };
        cleanup = storage.writeCleanupTombstone(
          installationId,
          deletingCheckpoint
        );
        if (!sameRecord(storage.readCleanupTombstone(installationId), cleanup)) {
          throw localEntryError("ENTRY_CLEANUP_CHECKPOINT_FAILED");
        }
        await cacheLifecycle.deleteIdentity(identity, {
          onBlocked: () => transition("revoked", {
            code: "MEMBER_CACHE_DELETE_BLOCKED",
            cleanupBlocked: true,
            showRetry: true
          }, () => retryCleanup(installationId))
        });
        const pointerCleared = storage.clearIdentityPointer(
          installationId,
          identity
        );
        if (!pointerCleared || storage.readIdentityPointer(installationId)) {
          throw localEntryError("ENTRY_IDENTITY_POINTER_RETAINED");
        }
      }
      if (expectedMarker) {
        const markerCleared = await clearSupportedMarker(
          installationId,
          expectedMarker
        );
        if (markerCleared !== true || storage.readLockMarker(installationId)) {
          throw localEntryError("ENTRY_MARKER_CHANGED");
        }
      }
      if (storage.readIdentityPointer(installationId)) {
        throw localEntryError("ENTRY_IDENTITY_POINTER_RETAINED");
      }
      if (storage.readInstallationId() === installationId) {
        const rotated = storage.rotateInstallationId(installationId);
        if (rotated === installationId || storage.readInstallationId() !== rotated) {
          throw localEntryError("ENTRY_CLEANUP_CHECKPOINT_FAILED");
        }
      }
      const tombstoneCleared = storage.clearCleanupTombstone(
        installationId,
        cleanup.transitionId
      );
      if (tombstoneCleared !== true || storage.readCleanupTombstone(installationId)) {
        throw localEntryError("ENTRY_CLEANUP_CHECKPOINT_FAILED");
      }
      const complete = storage.advanceLifecycle(
        installationId,
        "revoked",
        cleanup.transitionId
      );
      publish("device-revoke-complete", complete, installationId);
      transition("unpaired");
      return complete;
    });
  }

  async function cleanupSupported(
    installationId,
    transitionId = uuid(),
    expectedMarker = storage.readLockMarker(installationId)
  ) {
    await mutationLock.runCookieMutation(async () => {
      let targetExists = false;
      await mutationLock.run(installationId, async () => {
        targetExists = Boolean(
          ensureTargetTombstoneLocked(installationId, transitionId)
        );
      });
      if (!targetExists) return;
      const target = storage.readCleanupTombstone(installationId);
      const cookiesAlreadyCleared = await finishOriginOwnerWhileCookieLocked(
        () =>
          !destroyed &&
          storage.readInstallationId() === installationId &&
          sameRecord(storage.readCleanupTombstone(installationId), target) &&
          target?.cookiesCleared === false &&
          sameRecord(storage.readLockMarker(installationId), expectedMarker)
      );
      await mutationLock.run(installationId, () =>
        mutationLock.runProductDrain(installationId, () =>
          revokeLocked(installationId, {
            cookiesAlreadyCleared,
            expectedMarker
          })
        )
      );
    });
  }

  function revoke(error, installationId) {
    if (activeRevokes.has(installationId)) {
      return activeRevokes.get(installationId);
    }
    const operation = Promise.resolve().then(
      () => revokeOnce(error, installationId)
    );
    activeRevokes.set(installationId, operation);
    const release = () => {
      if (activeRevokes.get(installationId) === operation) {
        activeRevokes.delete(installationId);
      }
    };
    operation.then(release, release);
    return operation;
  }

  async function revokeOnce(_error, installationId) {
    const current = storage.readInstallationId();
    const existing = storage.readCleanupTombstone(installationId);
    if (current !== installationId && !existing) return;
    if (!mutationLock.available) {
      if (current === installationId) storage.ensureStickyLockMarker(installationId);
      await stopTrackedWorkbench();
      transition("revoked", {
        code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
        message: "请使用支持 Web Locks 的浏览器完成安全入口清理。",
        showRetry: true
      }, () => retryCleanup(installationId));
      return;
    }
    const marker = await writeSupportedMarker(installationId);
    if (!marker) return;
    await stopTrackedWorkbench();
    transition("revoked", { showRetry: true });
    try {
      await cleanupSupported(installationId, uuid(), marker);
    } catch (cleanupError) {
      await stopTrackedWorkbench().catch(() => undefined);
      transition("recoverable_error", {
        code: cleanupError?.code ?? "GATEWAY_UNAVAILABLE",
        message: cleanupError?.message,
        showRetry: true
      }, () => retryCleanup(installationId));
    }
  }

  async function retryCleanup(installationId) {
    const existing = storage.readCleanupTombstone(installationId);
    if (!existing && storage.readInstallationId() !== installationId) {
      transition("unpaired");
      return;
    }
    if (!mutationLock.available) {
      transition("revoked", {
        code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
        message: "请使用支持 Web Locks 的浏览器完成安全入口清理。",
        showRetry: true
      }, () => retryCleanup(installationId));
      return;
    }
    await stopTrackedWorkbench();
    try {
      await cleanupSupported(
        installationId,
        existing?.transitionId ?? uuid()
      );
      if (
        !storage.readCleanupTombstone(installationId) &&
        storage.readInstallationId() !== installationId
      ) transition("unpaired");
    } catch (error) {
      transition("recoverable_error", {
        code: error?.code ?? "GATEWAY_UNAVAILABLE",
        message: error?.message,
        showRetry: true
      }, () => retryCleanup(installationId));
    }
  }

  async function removeDevice() {
    const installationId = storage.readInstallationId();
    if (!installationId) return;
    if (!mutationLock.available) {
      transition("locked", {
        code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
        showResume: true,
        showRetry: true
      }, removeDevice);
      return;
    }
    const marker = await writeSupportedMarker(installationId);
    if (!marker) return;
    await stopTrackedWorkbench();
    transition("locked", { showResume: true });
    try {
      await mutationLock.runCookieMutation(async () => {
        const cookiesAlreadyCleared = await finishOriginOwnerWhileCookieLocked();
        await mutationLock.run(installationId, () =>
          mutationLock.runProductDrain(installationId, async () => {
            if (
              destroyed ||
              storage.readInstallationId() !== installationId ||
              !sameRecord(storage.readLockMarker(installationId), marker) ||
              storage.readCleanupTombstone(installationId) ||
              currentCookieOwner()
            ) return;
            try {
              await api.revokeWebDevice();
            } catch (error) {
              if (error?.code !== "DEVICE_REVOKED") throw error;
            }
            ensureTargetTombstoneLocked(installationId);
            await revokeLocked(installationId, {
              cookiesAlreadyCleared,
              expectedMarker: marker
            });
          })
        );
      });
    } catch (error) {
      await stopTrackedWorkbench().catch(() => undefined);
      transition("locked", {
        code: error?.code ?? "GATEWAY_UNAVAILABLE",
        message: error?.message,
        showResume: true,
        showRetry: true
      }, removeDevice);
    }
  }

  async function handleEntryFailure(error, installationId) {
    const invalidating = isInvalidatingError(error);
    const recoverable = isSessionError(error);
    if (!invalidating && !recoverable) return false;
    if (
      destroyed ||
      !installationId ||
      storage.readInstallationId() !== installationId
    ) return true;
    try {
      if (invalidating && activeRevokes.has(installationId)) return true;
      if (invalidating) await revoke(error, installationId);
      else await recoverAuthenticatedSession(installationId);
    } catch (recoveryError) {
      await stopTrackedWorkbench().catch(() => undefined);
      transition("recoverable_error", {
        code: recoveryError?.code ?? "GATEWAY_UNAVAILABLE",
        message: recoveryError?.message,
        showRetry: true
      }, () => {
        const cleanup = storage.readCleanupTombstone(installationId);
        const lifecycle = storage.readLifecycle(installationId);
        return cleanup || lifecycle?.state === "revoked"
          ? retryCleanup(installationId)
          : invalidating
            ? revoke(error, installationId)
            : recoverAuthenticatedSession(installationId);
      });
    }
    return true;
  }

  async function bootstrap({ pendingClaim = null, fragmentError = null } = {}) {
    if (destroyed) return;
    try {
      const cookieOwner = currentCookieOwner();
      if (cookieOwner) {
        await retryOriginCookieCleanup(
          cookieOwner.kind,
          cookieOwner.record.transitionId
        );
        return;
      }
      const cleanupRecords = storage.listCleanupTombstones();
      if (cleanupRecords.length > 0) {
        await retryCleanup(cleanupRecords[0].installationId);
        return;
      }
      const installationId = storage.readInstallationId();
      if (!installationId) {
        transition("unpaired");
        return;
      }
      const lifecycleBeforeLegacy = storage.readLifecycle(installationId);
      if (
        lifecycleBeforeLegacy?.state === "revoked" &&
        !storage.readIdentityPointer(installationId)
      ) {
        await retryCleanup(installationId);
        return;
      }
      try {
        await cacheLifecycle.deleteLegacy();
      } catch (error) {
        transition("recoverable_error", {
          code: error?.code ?? "LEGACY_CACHE_DELETE_FAILED",
          message: error?.message,
          showRetry: true
        }, () => bootstrap({ pendingClaim, fragmentError }));
        return;
      }
      if (fragmentError) {
        transition("unpaired", {
          code: fragmentError?.code ?? "PAIRING_FRAGMENT_INVALID",
          message: "配对链接无效，请重新获取。"
        });
        return;
      }
      if (pendingClaim) {
        await claim(pendingClaim);
        return;
      }
      const marker = storage.readLockMarker(installationId);
      const lifecycle = storage.readLifecycle(installationId);
      if (marker || lifecycle?.state === "locked") {
        await stopForLockedState();
        transition("locked", { showResume: true });
        return;
      }
      if (lifecycle?.state === "revoked") {
        await stopTrackedWorkbench();
        transition("revoked", { showRetry: true });
        return;
      }
      let ticket = null;
      const expectedLifecycle = snapshotLifecycle(lifecycle);
      try {
        await runCookieAndEntry(installationId, async () => {
          if (
            storage.readInstallationId() !== installationId ||
            !lifecycleMatches(installationId, expectedLifecycle) ||
            storage.readLockMarker(installationId) ||
            storage.readCleanupTombstone(installationId) ||
            currentCookieOwner()
          ) return;
          const response = await api.getWebContext();
          if (
            destroyed ||
            storage.readInstallationId() !== installationId ||
            !lifecycleMatches(installationId, expectedLifecycle) ||
            storage.readLockMarker(installationId) ||
            storage.readCleanupTombstone(installationId)
          ) return;
          ticket = {
            context: response.context,
            installationId,
            expectedLifecycle
          };
        });
      } catch (error) {
        if (isInvalidatingError(error)) {
          await revoke(error, installationId);
          return;
        }
        if (isSessionError(error)) {
          if (storage.readLockMarker(installationId)) {
            await stopForLockedState();
            transition("locked", { showResume: true });
          } else {
            await recoverAuthenticatedSession(installationId);
          }
          return;
        }
        if (error?.retryable || error instanceof TypeError || error?.status >= 500) {
          await stopTrackedWorkbench();
          transition("recoverable_error", {
            code: error?.code ?? "GATEWAY_UNAVAILABLE",
            message: error?.message,
            showRetry: true
          }, () => bootstrap({ pendingClaim, fragmentError }));
          return;
        }
        transition("unpaired", { code: error?.code, message: error?.message });
        return;
      }
      if (!ticket) return;
      const started = await startWithContext(
        ticket.context,
        ticket.installationId,
        ticket.expectedLifecycle
      );
      if (started) transition("active");
    } catch (error) {
      await stopTrackedWorkbench().catch(() => undefined);
      transition("recoverable_error", {
        code: error?.code ?? "GATEWAY_UNAVAILABLE",
        message: error?.message,
        showRetry: true
      }, () => bootstrap({ pendingClaim, fragmentError }));
    }
  }

  async function handleReceiverFailure(error, installationId) {
    if (await handleEntryFailure(error, installationId)) return;
    if (storage.readInstallationId() !== installationId) return;
    await stopTrackedWorkbench();
    transition("recoverable_error", {
      code: error?.code ?? "GATEWAY_UNAVAILABLE",
      message: error?.message,
      showRetry: true
    }, () => applyLatestInstallationState(installationId));
  }

  function enqueueReceiver(installationId, operation) {
    receiverLane = receiverLane
      .then(() => destroyed ? undefined : operation())
      .catch((error) => destroyed
        ? undefined
        : handleReceiverFailure(error, installationId));
    return receiverLane;
  }

  async function applyLatestInstallationState(
    installationId,
    { forceRefresh = false, requireActiveEvidence = false } = {}
  ) {
    for (;;) {
      if (destroyed) return;
      const lifecycle = storage.readLifecycle(installationId);
      const revision = lifecycle?.revision ?? 0;
      const expectedLifecycle = snapshotLifecycle(lifecycle);
      const lastApplied = lastAppliedRevisions.get(installationId) ?? 0;
      if (requireActiveEvidence && !lifecycle) {
        await stopTrackedWorkbench();
        transition("recoverable_error", {
          code: "ENTRY_LIFECYCLE_MISSING",
          showRetry: true
        });
        return;
      }
      if (lifecycle && revision < lastApplied) {
        await stopTrackedWorkbench();
        transition("recoverable_error", {
          code: "ENTRY_LIFECYCLE_CHANGED_DURING_START",
          showRetry: true
        });
        return;
      }
      const marker = storage.readLockMarker(installationId);
      const cleanup = storage.readCleanupTombstone(installationId);
      const cookieOwner = currentCookieOwner();
      if (cookieOwner) {
        const result = await retryOriginCookieCleanup(
          cookieOwner.kind,
          cookieOwner.record.transitionId
        );
        if (result === "gone") continue;
        return;
      }
      if (storage.readInstallationId() !== installationId && !cleanup) {
        return;
      }
      if (cleanup || lifecycle?.state === "revoked") {
        await stopTrackedWorkbench();
        if (destroyed) return;
        if (
          !sameRecord(storage.readCleanupTombstone(installationId), cleanup) ||
          (storage.readLifecycle(installationId)?.revision ?? 0) !== revision
        ) continue;
        lastAppliedRevisions.set(installationId, revision);
        transition("revoked", { showRetry: true });
        return;
      }
      if (marker || lifecycle?.state === "locked") {
        await stopForLockedState();
        if (destroyed) return;
        if (
          !sameRecord(storage.readLockMarker(installationId), marker) ||
          (storage.readLifecycle(installationId)?.revision ?? 0) !== revision
        ) continue;
        lastAppliedRevisions.set(installationId, revision);
        transition("locked", { showResume: true });
        return;
      }
      if (
        !forceRefresh &&
        revision <= lastApplied &&
        activeProductInstallationId === installationId
      ) return;
      if (lifecycle?.state !== "active") return;
      let ticket = null;
      const result = await runCookieAndEntry(installationId, async () => {
        if (
          storage.readInstallationId() !== installationId ||
          !lifecycleMatches(installationId, expectedLifecycle) ||
          storage.readLockMarker(installationId) ||
          storage.readCleanupTombstone(installationId) ||
          currentCookieOwner()
        ) return "retry";
        const response = await api.getWebContext();
        if (destroyed) return "handled";
        if (
          storage.readInstallationId() !== installationId ||
          !lifecycleMatches(installationId, expectedLifecycle) ||
          storage.readLockMarker(installationId) ||
          storage.readCleanupTombstone(installationId)
        ) return "retry";
        ticket = {
          context: response.context,
          installationId,
          expectedLifecycle
        };
        return "active";
      });
      if (result === "retry") continue;
      if (result !== "active") return;
      const started = await startWithContext(
        ticket.context,
        ticket.installationId,
        ticket.expectedLifecycle
      );
      if (!started) return;
      if (
        storage.readInstallationId() !== installationId ||
        !lifecycleMatches(installationId, expectedLifecycle) ||
        storage.readLockMarker(installationId) ||
        storage.readCleanupTombstone(installationId)
      ) {
        await stopTrackedWorkbench();
        continue;
      }
      lastAppliedRevisions.set(installationId, revision);
      transition("active");
      return;
    }
  }

  const channelListener = (event) => {
    const message = event.data;
    if (!validLifecycleWake(message)) return;
    if (!hasInstallationEvidence(message.installationId)) return;
    void enqueueReceiver(
      message.installationId,
      () => applyLatestInstallationState(message.installationId, {
        requireActiveEvidence: message.type === "session-restored"
      })
    );
  };

  const storageListener = (event) => {
    if (
      event.key === CLAIM_COOKIE_INTENT_KEY ||
      event.key === COOKIE_CLEAR_PENDING_KEY
    ) {
      const wake = storage.readCookieOwnerWakeFromEvent(event);
      if (!wake) return;
      void enqueueReceiver(wake.owner.installationId, async () => {
        const pending = currentCookieOwner();
        if (pending) {
          const result = await retryOriginCookieCleanup(
            pending.kind,
            pending.record.transitionId
          );
          if (result !== "gone") return;
        }
        if (destroyed) return;
        if (wake.kind === "set") await stopTrackedWorkbench();
        if (mutationLock.available) {
          await mutationLock.runCookieMutation(async () => undefined);
        }
        await applyLatestInstallationState(
          storage.readInstallationId(),
          { forceRefresh: wake.kind === "set" }
        );
      });
      return;
    }
    const affected = installationIdForStorageKey(event.key);
    if (!affected && event.key !== INSTALLATION_KEY) return;
    const source = affected ?? initialInstallationId;
    if (!source) return;
    void enqueueReceiver(source, () => applyLatestInstallationState(source));
  };

  channel?.addEventListener("message", channelListener);
  eventTarget?.addEventListener?.("storage", storageListener);

  async function retry() {
    if (typeof retryAction === "function") await retryAction();
  }

  async function whenIdle() {
    for (;;) {
      const captured = receiverLane;
      await captured;
      if (captured === receiverLane) return;
    }
  }

  function destroy() {
    if (destroyPromise) return destroyPromise;
    destroyed = true;
    activeClaimAbort?.abort();
    eventTarget?.removeEventListener?.("storage", storageListener);
    channel?.removeEventListener?.("message", channelListener);
    channel?.close();
    destroyPromise = stopTrackedWorkbench().catch(() => undefined);
    return destroyPromise;
  }

  return {
    bootstrap,
    claim,
    logout,
    resume,
    removeDevice,
    revoke,
    retry,
    retryCleanup,
    handleEntryFailure,
    getState,
    whenIdle,
    destroy
  };
}
