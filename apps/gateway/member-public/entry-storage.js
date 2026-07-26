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

function readExactFields(value, keys) {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
    ) return null;
    const ownKeys = Object.keys(value);
    if (
      ownKeys.length !== keys.length
      || keys.some((key) => !ownKeys.includes(key))
    ) return null;
    const fields = {};
    for (const key of keys) fields[key] = value[key];
    return fields;
  } catch {
    throw invalidRecord();
  }
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

function canonicalIdentity(value) {
  const fields = readExactFields(
    value,
    ["familyRef", "personRef", "deviceRef"]
  );
  if (
    !fields
    || typeof fields.familyRef !== "string"
    || typeof fields.personRef !== "string"
    || typeof fields.deviceRef !== "string"
    || !FAMILY_REF_PATTERN.test(fields.familyRef)
    || !PERSON_REF_PATTERN.test(fields.personRef)
    || !DEVICE_REF_PATTERN.test(fields.deviceRef)
  ) return null;
  return {
    familyRef: fields.familyRef,
    personRef: fields.personRef,
    deviceRef: fields.deviceRef
  };
}

function sameIdentity(left, right) {
  return left.familyRef === right.familyRef
    && left.personRef === right.personRef
    && left.deviceRef === right.deviceRef;
}

function canonicalLockMarker(value) {
  const fields = readExactFields(value, ["protocolVersion", "lockedAt"]);
  if (
    !fields
    || fields.protocolVersion !== 2
    || !validTimestamp(fields.lockedAt)
  ) return null;
  return {
    protocolVersion: 2,
    lockedAt: fields.lockedAt
  };
}

function canonicalIdentityPointer(value) {
  const fields = readExactFields(value, [
    "protocolVersion",
    "familyRef",
    "personRef",
    "deviceRef"
  ]);
  if (!fields || fields.protocolVersion !== 2) return null;
  const identity = canonicalIdentity({
    familyRef: fields.familyRef,
    personRef: fields.personRef,
    deviceRef: fields.deviceRef
  });
  return identity ? { protocolVersion: 2, ...identity } : null;
}

function canonicalLifecycle(value) {
  const fields = readExactFields(value, [
    "protocolVersion",
    "revision",
    "state",
    "transitionId"
  ]);
  if (
    !fields
    || fields.protocolVersion !== 2
    || !Number.isSafeInteger(fields.revision)
    || fields.revision <= 0
    || !LIFECYCLE_STATES.has(fields.state)
    || !validUuid(fields.transitionId)
  ) return null;
  return {
    protocolVersion: 2,
    revision: fields.revision,
    state: fields.state,
    transitionId: fields.transitionId
  };
}

function canonicalTombstone(value) {
  const fields = readExactFields(value, [
    "protocolVersion",
    "transitionId",
    "identity",
    "phase",
    "cookiesCleared"
  ]);
  if (
    !fields
    || fields.protocolVersion !== 2
    || !validUuid(fields.transitionId)
    || !["closing", "deleting"].includes(fields.phase)
    || typeof fields.cookiesCleared !== "boolean"
  ) return null;
  const identity = fields.identity === null
    ? null
    : canonicalIdentity(fields.identity);
  if (fields.identity !== null && identity === null) return null;
  if (
    fields.phase === "deleting"
    && (identity === null || fields.cookiesCleared !== true)
  ) return null;
  return {
    protocolVersion: 2,
    transitionId: fields.transitionId,
    identity,
    phase: fields.phase,
    cookiesCleared: fields.cookiesCleared
  };
}

function canonicalCookieOwner(value) {
  const fields = readExactFields(value, [
    "protocolVersion",
    "transitionId",
    "installationId",
    "createdAt"
  ]);
  if (
    !fields
    || fields.protocolVersion !== 2
    || !validUuid(fields.transitionId)
    || !validUuid(fields.installationId)
    || !validTimestamp(fields.createdAt)
  ) return null;
  return {
    protocolVersion: 2,
    transitionId: fields.transitionId,
    installationId: fields.installationId,
    createdAt: fields.createdAt
  };
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
    return validator(value);
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

  function getOrCreateInstallationIdLocked() {
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
      canonicalLockMarker
    );
  }

  // No-Web-Locks Logout only: ensure one sticky marker, never replace or clear.
  function ensureStickyLockMarker(installationId) {
    requireInstallationId(installationId);
    const current = readLockMarker(installationId);
    if (current) return current;
    let marker;
    try {
      const wallMillis = now().getTime();
      if (!Number.isFinite(wallMillis)) throw invalidRecord();
      marker = {
        protocolVersion: 2,
        lockedAt: new Date(wallMillis).toISOString()
      };
    } catch {
      throw invalidRecord();
    }
    localStorage.setItem(lockKey(installationId), JSON.stringify(marker));
    return marker;
  }

  function writeLockMarkerLocked(installationId) {
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

  function clearLockMarkerLocked(installationId, expectedMarker) {
    requireInstallationId(installationId);
    const key = lockKey(installationId);
    const currentText = localStorage.getItem(key);
    if (currentText === null) return false;
    const current = parseEventRecord(currentText, canonicalLockMarker);
    if (!current) throw invalidRecord();
    if (arguments.length < 2) {
      localStorage.removeItem(key);
      return true;
    }
    const expected = canonicalLockMarker(expectedMarker);
    if (!expected || currentText !== JSON.stringify(expected)) return false;
    localStorage.removeItem(key);
    return true;
  }

  function readIdentityPointer(installationId) {
    if (!validUuid(installationId)) return null;
    return readStoredRecord(
      localStorage,
      identityKey(installationId),
      canonicalIdentityPointer
    );
  }

  function writeIdentityPointer(installationId, identity) {
    requireInstallationId(installationId);
    const canonical = canonicalIdentity(identity);
    if (!canonical) throw invalidRecord();
    const current = readIdentityPointer(installationId);
    if (current) {
      if (!sameIdentity(current, canonical)) throw identityConflict();
      return current;
    }
    const pointer = { protocolVersion: 2, ...canonical };
    localStorage.setItem(identityKey(installationId), JSON.stringify(pointer));
    return pointer;
  }

  function clearIdentityPointer(installationId, expectedIdentity) {
    requireInstallationId(installationId);
    const key = identityKey(installationId);
    const currentText = localStorage.getItem(key);
    if (currentText === null) return false;
    const current = parseEventRecord(currentText, canonicalIdentityPointer);
    if (!current) throw invalidRecord();
    if (arguments.length < 2) {
      localStorage.removeItem(key);
      return true;
    }
    const expected = canonicalIdentity(expectedIdentity);
    if (!expected || !sameIdentity(current, expected)) {
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
      canonicalTombstone
    );
  }

  function listCleanupTombstones() {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (typeof key === "string" && key.startsWith(TOMBSTONE_PREFIX)) {
        keys.push(key);
      }
    }
    const records = [];
    for (const key of keys) {
      const installationId = key.slice(TOMBSTONE_PREFIX.length);
      if (!validUuid(installationId)) throw invalidRecord();
      const tombstone = readStoredRecord(localStorage, key, canonicalTombstone);
      if (tombstone === null) continue;
      records.push({ installationId, tombstone });
    }
    return records.sort((left, right) =>
      left.installationId.localeCompare(right.installationId)
    );
  }

  function writeCleanupTombstone(installationId, tombstone) {
    requireInstallationId(installationId);
    const next = canonicalTombstone(tombstone);
    if (!next) throw invalidRecord();
    const current = readCleanupTombstone(installationId);
    if (current) {
      const regressed = current.transitionId !== next.transitionId
        || (current.cookiesCleared && !next.cookiesCleared)
        || (current.phase === "deleting" && next.phase !== "deleting")
        || (
          current.identity !== null
          && (
            next.identity === null
            || !sameIdentity(current.identity, next.identity)
          )
        );
      if (regressed) throw tombstoneRegression();
    }
    localStorage.setItem(
      tombstoneKey(installationId),
      JSON.stringify(next)
    );
    return next;
  }

  function clearCleanupTombstone(installationId, expectedTransitionId) {
    requireInstallationId(installationId);
    const current = readCleanupTombstone(installationId);
    if (!current || current.transitionId !== expectedTransitionId) return false;
    localStorage.removeItem(tombstoneKey(installationId));
    return true;
  }

  function readCookieOwner(key) {
    return readStoredRecord(localStorage, key, canonicalCookieOwner);
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
    const canonical = canonicalCookieOwner(intent);
    if (!canonical) throw invalidRecord();
    requireNoCookieOwner(COOKIE_CLEAR_PENDING_KEY);
    const current = readClaimCookieIntent();
    if (current) {
      if (current.transitionId !== canonical.transitionId) throw ownerConflict();
      return current;
    }
    localStorage.setItem(CLAIM_COOKIE_INTENT_KEY, JSON.stringify(canonical));
    return canonical;
  }

  function writeCookieClearPending(signal) {
    const canonical = canonicalCookieOwner(signal);
    if (!canonical) throw invalidRecord();
    requireNoCookieOwner(CLAIM_COOKIE_INTENT_KEY);
    const current = readCookieClearPending();
    if (current) return current;
    localStorage.setItem(COOKIE_CLEAR_PENDING_KEY, JSON.stringify(canonical));
    return canonical;
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
    let key;
    try {
      key = storageEvent?.key;
    } catch {
      throw invalidRecord();
    }
    if (
      key !== CLAIM_COOKIE_INTENT_KEY
      && key !== COOKIE_CLEAR_PENDING_KEY
    ) return null;
    let oldValue;
    let newValue;
    try {
      oldValue = storageEvent.oldValue;
      newValue = storageEvent.newValue;
    } catch {
      throw invalidRecord();
    }
    if (oldValue === null && newValue !== null) {
      const owner = parseEventRecord(newValue, canonicalCookieOwner);
      return owner ? { kind: "set", owner } : null;
    }
    if (newValue === null) {
      const owner = parseEventRecord(oldValue, canonicalCookieOwner);
      return owner ? { kind: "clear", owner } : null;
    }
    return null;
  }

  function readLifecycle(installationId) {
    if (!validUuid(installationId)) return null;
    return readStoredRecord(
      localStorage,
      lifecycleKey(installationId),
      canonicalLifecycle
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
    getOrCreateInstallationIdLocked,
    readInstallationId,
    rotateInstallationId,
    readLockMarker,
    ensureStickyLockMarker,
    writeLockMarkerLocked,
    clearLockMarkerLocked,
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
