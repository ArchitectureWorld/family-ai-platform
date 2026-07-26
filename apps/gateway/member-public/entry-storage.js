export const INSTALLATION_KEY = "family-ai-web-installation-id";
const LOCK_PREFIX = "family-ai-member-entry-lock:";
const IDENTITY_PREFIX = "family-ai-member-cache-identity:";
const LIFECYCLE_PREFIX = "family-ai-member-entry-state:";
const TOMBSTONE_PREFIX = "family-ai-member-revoke-cleanup:";

const lockKey = (installationId) => `${LOCK_PREFIX}${installationId}`;
const identityKey = (installationId) =>
  `${IDENTITY_PREFIX}${installationId}`;
const lifecycleKey = (installationId) =>
  `${LIFECYCLE_PREFIX}${installationId}`;
const tombstoneKey = (installationId) =>
  `${TOMBSTONE_PREFIX}${installationId}`;

export const CLAIM_COOKIE_INTENT_KEY =
  "family-ai-member-claim-cookie-intent";
export const COOKIE_CLEAR_PENDING_KEY =
  "family-ai-member-cookie-clear-pending";

const STANDARD_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;
const SPECIAL_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff"
]);
const FAMILY_REF_PATTERN = /^family:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const PERSON_REF_PATTERN = /^person:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const DEVICE_REF_PATTERN = /^device:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const LIFECYCLE_STATES = new Set(["active", "locked", "revoked"]);
const INSTALLATION_PREFIXES = [
  LOCK_PREFIX,
  IDENTITY_PREFIX,
  LIFECYCLE_PREFIX,
  TOMBSTONE_PREFIX
];

function exactObject(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validUuid(value) {
  return typeof value === "string"
    && (STANDARD_UUID_PATTERN.test(value) || SPECIAL_UUIDS.has(value));
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis)
    && new Date(millis).toISOString() === value;
}

function validIdentity(value) {
  return exactObject(value, ["familyRef", "personRef", "deviceRef"])
    && FAMILY_REF_PATTERN.test(value.familyRef)
    && PERSON_REF_PATTERN.test(value.personRef)
    && DEVICE_REF_PATTERN.test(value.deviceRef);
}

function sameIdentity(left, right) {
  return left?.familyRef === right?.familyRef
    && left?.personRef === right?.personRef
    && left?.deviceRef === right?.deviceRef;
}

function validLockMarker(value) {
  return exactObject(value, ["protocolVersion", "lockedAt"])
    && value.protocolVersion === 2
    && validTimestamp(value.lockedAt);
}

function validIdentityPointer(value) {
  return exactObject(value, [
    "protocolVersion",
    "familyRef",
    "personRef",
    "deviceRef"
  ])
    && value.protocolVersion === 2
    && validIdentity({
      familyRef: value.familyRef,
      personRef: value.personRef,
      deviceRef: value.deviceRef
    });
}

function validLifecycle(value) {
  return exactObject(value, [
    "protocolVersion",
    "revision",
    "state",
    "transitionId"
  ])
    && value.protocolVersion === 2
    && Number.isSafeInteger(value.revision)
    && value.revision > 0
    && LIFECYCLE_STATES.has(value.state)
    && validUuid(value.transitionId);
}

function validTombstone(value) {
  if (!exactObject(value, [
    "protocolVersion",
    "transitionId",
    "identity",
    "phase",
    "cookiesCleared"
  ])) return false;
  if (
    value.protocolVersion !== 2
    || !validUuid(value.transitionId)
    || !["closing", "deleting"].includes(value.phase)
    || typeof value.cookiesCleared !== "boolean"
    || (value.identity !== null && !validIdentity(value.identity))
  ) return false;
  return value.phase !== "deleting"
    || (value.identity !== null && value.cookiesCleared === true);
}

function validCookieOwner(value) {
  return exactObject(value, [
    "protocolVersion",
    "transitionId",
    "installationId",
    "createdAt"
  ])
    && value.protocolVersion === 2
    && validUuid(value.transitionId)
    && validUuid(value.installationId)
    && validTimestamp(value.createdAt);
}

function invalidRecord() {
  const error = new Error("ENTRY_STORAGE_INVALID");
  error.code = "ENTRY_STORAGE_INVALID";
  return error;
}

function parseEventRecord(text, validator) {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return validator(value) ? value : null;
  } catch {
    return null;
  }
}

function readStoredRecord(localStorage, key, validator) {
  const text = localStorage.getItem(key);
  if (text === null) return null;
  const value = parseEventRecord(text, validator);
  if (!value) throw invalidRecord();
  return value;
}

function ownerConflict() {
  const error = new Error("ENTRY_COOKIE_OWNER_CONFLICT");
  error.code = "ENTRY_COOKIE_OWNER_CONFLICT";
  return error;
}

function identityConflict() {
  const error = new Error("ENTRY_STORAGE_IDENTITY_CONFLICT");
  error.code = "ENTRY_STORAGE_IDENTITY_CONFLICT";
  return error;
}

function tombstoneRegression() {
  const error = new Error("ENTRY_TOMBSTONE_REGRESSION");
  error.code = "ENTRY_TOMBSTONE_REGRESSION";
  return error;
}

function requireInstallationId(installationId) {
  if (!validUuid(installationId)) throw invalidRecord();
}

export function installationIdForStorageKey(key) {
  if (typeof key !== "string") return null;
  const prefix = INSTALLATION_PREFIXES.find((candidate) =>
    key.startsWith(candidate)
  );
  if (!prefix) return null;
  const installationId = key.slice(prefix.length);
  return validUuid(installationId) ? installationId : null;
}

export function createEntryStorage({
  localStorage = globalThis.localStorage,
  cryptoImpl = globalThis.crypto,
  now = () => new Date()
} = {}) {
  function readInstallationId() {
    const value = localStorage.getItem(INSTALLATION_KEY);
    if (value === null) return null;
    if (!validUuid(value)) throw invalidRecord();
    return value;
  }

  function nextInstallationId(previousInstallationId = null) {
    if (typeof cryptoImpl?.randomUUID !== "function") throw invalidRecord();
    const value = cryptoImpl.randomUUID();
    if (
      !validUuid(value)
      || (
        previousInstallationId !== null
        && value.toLowerCase() === previousInstallationId.toLowerCase()
      )
    ) throw invalidRecord();
    return value;
  }

  function getOrCreateInstallationId() {
    const current = readInstallationId();
    if (current) return current;
    const next = nextInstallationId();
    localStorage.setItem(INSTALLATION_KEY, next);
    return next;
  }

  function rotateInstallationId(expectedInstallationId) {
    const current = readInstallationId();
    if (current !== expectedInstallationId) return current;
    const next = nextInstallationId(current);
    localStorage.setItem(INSTALLATION_KEY, next);
    return next;
  }

  function readLockMarker(installationId) {
    if (!validUuid(installationId)) return null;
    return readStoredRecord(
      localStorage,
      lockKey(installationId),
      validLockMarker
    );
  }

  function writeLockMarker(installationId) {
    requireInstallationId(installationId);
    const current = readLockMarker(installationId);
    const currentMillis = Date.parse(current?.lockedAt ?? "");
    const wallMillis = now().getTime();
    const lockedAtMillis = Number.isFinite(currentMillis)
      ? Math.max(wallMillis, currentMillis + 1)
      : wallMillis;
    const marker = {
      protocolVersion: 2,
      lockedAt: new Date(lockedAtMillis).toISOString()
    };
    localStorage.setItem(lockKey(installationId), JSON.stringify(marker));
    return marker;
  }

  function clearLockMarker(installationId, expectedMarker) {
    requireInstallationId(installationId);
    const key = lockKey(installationId);
    const currentText = localStorage.getItem(key);
    if (currentText === null) return false;
    if (arguments.length < 2) {
      localStorage.removeItem(key);
      return true;
    }
    const current = parseEventRecord(currentText, validLockMarker);
    if (!current) throw invalidRecord();
    if (
      !validLockMarker(expectedMarker)
      || currentText !== JSON.stringify(expectedMarker)
    ) return false;
    localStorage.removeItem(key);
    return true;
  }

  function readIdentityPointer(installationId) {
    if (!validUuid(installationId)) return null;
    return readStoredRecord(
      localStorage,
      identityKey(installationId),
      validIdentityPointer
    );
  }

  function writeIdentityPointer(installationId, identity) {
    requireInstallationId(installationId);
    if (!validIdentity(identity)) throw invalidRecord();
    const current = readIdentityPointer(installationId);
    if (current) {
      if (!sameIdentity(current, identity)) throw identityConflict();
      return current;
    }
    const pointer = { protocolVersion: 2, ...identity };
    localStorage.setItem(identityKey(installationId), JSON.stringify(pointer));
    return pointer;
  }

  function clearIdentityPointer(installationId, expectedIdentity) {
    requireInstallationId(installationId);
    const key = identityKey(installationId);
    const currentText = localStorage.getItem(key);
    if (currentText === null) return false;
    if (arguments.length < 2) {
      localStorage.removeItem(key);
      return true;
    }
    const current = parseEventRecord(currentText, validIdentityPointer);
    if (!current) throw invalidRecord();
    if (!validIdentity(expectedIdentity) || !sameIdentity(current, expectedIdentity)) {
      return false;
    }
    localStorage.removeItem(key);
    return true;
  }

  function readCleanupTombstone(installationId) {
    if (!validUuid(installationId)) return null;
    return readStoredRecord(
      localStorage,
      tombstoneKey(installationId),
      validTombstone
    );
  }

  function listCleanupTombstones() {
    const records = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (typeof key !== "string" || !key.startsWith(TOMBSTONE_PREFIX)) {
        continue;
      }
      const installationId = key.slice(TOMBSTONE_PREFIX.length);
      if (!validUuid(installationId)) throw invalidRecord();
      const tombstone = readStoredRecord(localStorage, key, validTombstone);
      records.push({ installationId, tombstone });
    }
    return records.sort((left, right) =>
      left.installationId.localeCompare(right.installationId)
    );
  }

  function writeCleanupTombstone(installationId, tombstone) {
    requireInstallationId(installationId);
    if (!validTombstone(tombstone)) throw invalidRecord();
    const current = readCleanupTombstone(installationId);
    if (current) {
      const regressed = current.transitionId !== tombstone.transitionId
        || (current.cookiesCleared && !tombstone.cookiesCleared)
        || (current.phase === "deleting" && tombstone.phase !== "deleting")
        || (
          current.identity !== null
          && (
            tombstone.identity === null
            || !sameIdentity(current.identity, tombstone.identity)
          )
        );
      if (regressed) throw tombstoneRegression();
    }
    localStorage.setItem(
      tombstoneKey(installationId),
      JSON.stringify(tombstone)
    );
    return tombstone;
  }

  function clearCleanupTombstone(installationId, expectedTransitionId) {
    requireInstallationId(installationId);
    const current = readCleanupTombstone(installationId);
    if (!current || current.transitionId !== expectedTransitionId) return false;
    localStorage.removeItem(tombstoneKey(installationId));
    return true;
  }

  function readCookieOwner(key) {
    return readStoredRecord(localStorage, key, validCookieOwner);
  }

  function readClaimCookieIntent() {
    return readCookieOwner(CLAIM_COOKIE_INTENT_KEY);
  }

  function readCookieClearPending() {
    return readCookieOwner(COOKIE_CLEAR_PENDING_KEY);
  }

  function requireNoCookieOwner(key) {
    const owner = readCookieOwner(key);
    if (owner) throw ownerConflict();
  }

  function writeClaimCookieIntent(intent) {
    if (!validCookieOwner(intent)) throw invalidRecord();
    requireNoCookieOwner(COOKIE_CLEAR_PENDING_KEY);
    const current = readClaimCookieIntent();
    if (current) {
      if (current.transitionId !== intent.transitionId) throw ownerConflict();
      return current;
    }
    localStorage.setItem(CLAIM_COOKIE_INTENT_KEY, JSON.stringify(intent));
    return intent;
  }

  function writeCookieClearPending(signal) {
    if (!validCookieOwner(signal)) throw invalidRecord();
    requireNoCookieOwner(CLAIM_COOKIE_INTENT_KEY);
    const current = readCookieClearPending();
    if (current) return current;
    localStorage.setItem(COOKIE_CLEAR_PENDING_KEY, JSON.stringify(signal));
    return signal;
  }

  function clearCookieOwner(key, expectedTransitionId) {
    const current = readCookieOwner(key);
    if (!current || current.transitionId !== expectedTransitionId) return false;
    localStorage.removeItem(key);
    return true;
  }

  function clearClaimCookieIntent(expectedTransitionId) {
    return clearCookieOwner(CLAIM_COOKIE_INTENT_KEY, expectedTransitionId);
  }

  function clearCookieClearPending(expectedTransitionId) {
    return clearCookieOwner(COOKIE_CLEAR_PENDING_KEY, expectedTransitionId);
  }

  function readCookieOwnerWakeFromEvent(storageEvent) {
    if (
      storageEvent?.key !== CLAIM_COOKIE_INTENT_KEY
      && storageEvent?.key !== COOKIE_CLEAR_PENDING_KEY
    ) return null;
    if (storageEvent.oldValue === null && storageEvent.newValue !== null) {
      const owner = parseEventRecord(storageEvent.newValue, validCookieOwner);
      return owner ? { kind: "set", owner } : null;
    }
    if (storageEvent.newValue === null) {
      const owner = parseEventRecord(storageEvent.oldValue, validCookieOwner);
      return owner ? { kind: "clear", owner } : null;
    }
    return null;
  }

  function readLifecycle(installationId) {
    if (!validUuid(installationId)) return null;
    return readStoredRecord(
      localStorage,
      lifecycleKey(installationId),
      validLifecycle
    );
  }

  function advanceLifecycle(installationId, state, transitionId) {
    requireInstallationId(installationId);
    if (!LIFECYCLE_STATES.has(state) || !validUuid(transitionId)) {
      throw invalidRecord();
    }
    const current = readLifecycle(installationId);
    const revision = (current?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw invalidRecord();
    const next = {
      protocolVersion: 2,
      revision,
      state,
      transitionId
    };
    localStorage.setItem(lifecycleKey(installationId), JSON.stringify(next));
    return next;
  }

  return {
    getOrCreateInstallationId,
    readInstallationId,
    rotateInstallationId,
    readLockMarker,
    writeLockMarker,
    clearLockMarker,
    readIdentityPointer,
    writeIdentityPointer,
    clearIdentityPointer,
    readCleanupTombstone,
    listCleanupTombstones,
    writeCleanupTombstone,
    clearCleanupTombstone,
    readClaimCookieIntent,
    writeClaimCookieIntent,
    clearClaimCookieIntent,
    readCookieClearPending,
    writeCookieClearPending,
    clearCookieClearPending,
    readCookieOwnerWakeFromEvent,
    readLifecycle,
    advanceLifecycle
  };
}
