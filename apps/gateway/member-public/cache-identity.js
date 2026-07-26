import { LEGACY_DATABASE_NAME, openMemberCache } from "./cache.js";

export function cacheIdentityFromContext(context) {
  return {
    familyRef: context.family.familyRef,
    personRef: context.person.personRef,
    deviceRef: context.device.deviceRef
  };
}

export function memberCacheDatabaseName(identity) {
  return [
    "family-ai-member-web-v2",
    identity.familyRef,
    identity.personRef,
    identity.deviceRef
  ].join(":");
}

export function sameCacheIdentity(left, right) {
  return left?.familyRef === right?.familyRef
    && left?.personRef === right?.personRef
    && left?.deviceRef === right?.deviceRef;
}

function cacheIdentityMismatch() {
  const error = new Error("CACHE_IDENTITY_MISMATCH");
  error.code = "CACHE_IDENTITY_MISMATCH";
  return error;
}

export async function validateOrInitializeMemberCacheContext(cache, context) {
  const identity = cacheIdentityFromContext(context);
  return cache.transaction(["meta"], async (transaction) => {
    const storedContext = await transaction.get("meta", "context");
    if (storedContext?.value && !sameCacheIdentity(cacheIdentityFromContext(storedContext.value), identity)) {
      throw cacheIdentityMismatch();
    }
    await transaction.put("meta", { key: "context", value: context });
  });
}

export async function openIdentityMemberCache(context, { openCache = openMemberCache } = {}) {
  const identity = cacheIdentityFromContext(context);
  const cache = await openCache(memberCacheDatabaseName(identity));
  try {
    await validateOrInitializeMemberCacheContext(cache, context);
    return { cache, identity };
  } catch (error) {
    cache.close();
    throw error;
  }
}

export function deleteLegacyMemberCache({ indexedDBImpl = globalThis.indexedDB } = {}) {
  if (!indexedDBImpl) return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
  const request = indexedDBImpl.deleteDatabase(LEGACY_DATABASE_NAME);
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("INDEXED_DB_REQUEST_FAILED")), {
      once: true
    });
    request.addEventListener("blocked", () => {
      const error = new Error("LEGACY_CACHE_DELETE_BLOCKED");
      error.code = "LEGACY_CACHE_DELETE_BLOCKED";
      reject(error);
    }, { once: true });
  });
}

export function deleteIdentityMemberCache(
  identity,
  { indexedDBImpl = globalThis.indexedDB, onBlocked = () => {} } = {}
) {
  if (!indexedDBImpl) return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
  const request = indexedDBImpl.deleteDatabase(memberCacheDatabaseName(identity));
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("blocked", () => onBlocked());
    request.addEventListener("error", () => {
      const error = new Error("MEMBER_CACHE_DELETE_FAILED", { cause: request.error });
      error.code = "MEMBER_CACHE_DELETE_FAILED";
      reject(error);
    }, { once: true });
  });
}
