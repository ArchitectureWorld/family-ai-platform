import { describe, expect, it, vi } from "vitest";
import { MEMBER_CACHE_STORES, createMemoryCache, readBootstrapSnapshot } from "../member-public/cache.js";
import {
  cacheIdentityFromContext,
  deleteIdentityMemberCache,
  deleteLegacyMemberCache,
  memberCacheDatabaseName,
  openIdentityMemberCache,
  sameCacheIdentity,
  validateOrInitializeMemberCacheContext
} from "../member-public/cache-identity.js";

const contextFor = (suffix: string, displayName = suffix) => ({
  family: { familyRef: `family:${suffix}`, displayName: `Family ${displayName}`, role: "household" },
  person: { personRef: `person:${suffix}`, displayName, role: "member" },
  device: { deviceRef: `device:${suffix}`, displayName: `Browser ${displayName}`, platform: "web" }
});
const contextA = contextFor("alice", "Alice");
const contextB = contextFor("bob", "Bob");

async function populateA(cache: ReturnType<typeof createMemoryCache>) {
  await cache.transaction(MEMBER_CACHE_STORES, async (transaction) => {
    await transaction.put("meta", { key: "localAppliedSequence", value: 7 });
    await transaction.put("meta", { key: "selectedSection", value: "work" });
    await transaction.put("meta", { key: "selectedWorkRef", value: "work:a" });
    await transaction.put("threads", { threadRef: "thread:a" });
    await transaction.put("messages", { messageRef: "message:a", threadRef: "thread:a", threadSequence: 1 });
    await transaction.put("works", { workConversationRef: "work:a" });
    await transaction.put("progress", { workConversationRef: "work:a" });
    await transaction.put("drafts", { threadRef: "thread:a", text: "A private draft" });
    await transaction.put("outgoing", { clientMessageId: "client:a", threadRef: "thread:a" });
  });
}

function createEventRequest(result: unknown = undefined) {
  const listeners = new Map<string, Array<{ listener: () => void; once: boolean }>>();
  return {
    result,
    error: null as Error | null,
    addEventListener(type: string, listener: () => void, options?: { once?: boolean }) {
      listeners.set(type, [...(listeners.get(type) ?? []), { listener, once: options?.once === true }]);
    },
    emit(type: string) {
      const entries = listeners.get(type) ?? [];
      for (const entry of entries) entry.listener();
      listeners.set(type, entries.filter((entry) => !entry.once));
    }
  };
}

describe("Member cache identity namespace", () => {
  it("isolates A and B and reopens A by the exact identity triple", async () => {
    const registry = new Map<string, ReturnType<typeof createMemoryCache>>();
    const openCache = async (name: string) => {
      if (!registry.has(name)) registry.set(name, createMemoryCache());
      return registry.get(name)!;
    };
    const openedA = await openIdentityMemberCache(contextA, { openCache });
    await populateA(openedA.cache);
    const openedB = await openIdentityMemberCache(contextB, { openCache });
    expect(await readBootstrapSnapshot(openedB.cache)).toEqual({
      context: contextB, drafts: [], localAppliedSequence: 0, messages: [], outgoing: [], progress: [],
      selectedSection: "chat", selectedWorkRef: null, threads: [], works: []
    });
    const reopenedA = await openIdentityMemberCache(contextA, { openCache });
    expect(await readBootstrapSnapshot(reopenedA.cache)).toMatchObject({
      context: contextA, drafts: [{ text: "A private draft" }], localAppliedSequence: 7,
      messages: [{ messageRef: "message:a" }], outgoing: [{ clientMessageId: "client:a" }],
      progress: [{ workConversationRef: "work:a" }], selectedSection: "work", selectedWorkRef: "work:a",
      threads: [{ threadRef: "thread:a" }], works: [{ workConversationRef: "work:a" }]
    });
  });

  it("derives a stable database name from all three identity refs", () => {
    const identity = cacheIdentityFromContext(contextA);
    expect(memberCacheDatabaseName(identity)).toBe("family-ai-member-web-v2:family:alice:person:alice:device:alice");
    expect(sameCacheIdentity(identity, { familyRef: "family:alice", personRef: "person:alice", deviceRef: "device:alice" })).toBe(true);
    expect(memberCacheDatabaseName({ ...identity, familyRef: "family:other" })).not.toBe(memberCacheDatabaseName(identity));
    expect(memberCacheDatabaseName({ ...identity, personRef: "person:other" })).not.toBe(memberCacheDatabaseName(identity));
    expect(memberCacheDatabaseName({ ...identity, deviceRef: "device:other" })).not.toBe(memberCacheDatabaseName(identity));
    expect(sameCacheIdentity(identity, { familyRef: "family:alice", personRef: "person:alice", deviceRef: "device:other" })).toBe(false);
  });

  it("fails closed before projection reads when stored identity differs", async () => {
    const backing = createMemoryCache();
    await backing.transaction(["meta"], (transaction) => transaction.put("meta", { key: "context", value: contextA }));
    let projectionReads = 0;
    const close = vi.fn();
    const cache = {
      close,
      transaction: (storeNames: string[], callback: (transaction: any) => Promise<unknown>) =>
        backing.transaction(storeNames, (transaction) => callback({
          ...transaction,
          getAll: async (storeName: string) => {
            projectionReads += 1;
            return transaction.getAll(storeName);
          }
        }))
    };
    await expect(validateOrInitializeMemberCacheContext(cache, contextB)).rejects.toMatchObject({ code: "CACHE_IDENTITY_MISMATCH" });
    expect(projectionReads).toBe(0);
    await expect(openIdentityMemberCache(contextB, { openCache: async () => cache })).rejects.toMatchObject({ code: "CACHE_IDENTITY_MISMATCH" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("refreshes complete context fields for the same identity without losing projections", async () => {
    const cache = createMemoryCache();
    await validateOrInitializeMemberCacheContext(cache, contextA);
    await populateA(cache);
    const refreshed = {
      family: { ...contextA.family, displayName: "House of Alice", role: "owner" },
      person: { ...contextA.person, displayName: "Alicia", role: "admin" },
      device: { ...contextA.device, displayName: "Safari", platform: "macOS" }
    };
    await validateOrInitializeMemberCacheContext(cache, refreshed);
    expect(await readBootstrapSnapshot(cache)).toMatchObject({
      context: refreshed, drafts: [{ text: "A private draft" }], localAppliedSequence: 7,
      messages: [{ messageRef: "message:a" }], outgoing: [{ clientMessageId: "client:a" }],
      progress: [{ workConversationRef: "work:a" }], selectedSection: "work", selectedWorkRef: "work:a",
      threads: [{ threadRef: "thread:a" }], works: [{ workConversationRef: "work:a" }]
    });
  });
});

describe("Member cache deletion semantics", () => {
  it("resolves legacy deletion when IndexedDB succeeds", async () => {
    const request = createEventRequest();
    const deletion = deleteLegacyMemberCache({ indexedDBImpl: { deleteDatabase: () => request } as any });
    request.emit("success");
    await expect(deletion).resolves.toBeUndefined();
  });

  it("rejects legacy deletion immediately when IndexedDB reports blocked", async () => {
    const request = createEventRequest();
    const deletion = deleteLegacyMemberCache({ indexedDBImpl: { deleteDatabase: () => request } as any });
    request.emit("blocked");
    await expect(deletion).rejects.toMatchObject({ code: "LEGACY_CACHE_DELETE_BLOCKED" });
  });

  it("keeps identity deletion pending through blocked until a later success", async () => {
    const request = createEventRequest();
    const onBlocked = vi.fn();
    const deletion = deleteIdentityMemberCache(cacheIdentityFromContext(contextA), {
      indexedDBImpl: { deleteDatabase: () => request } as any, onBlocked
    });
    let settled = false;
    void deletion.finally(() => { settled = true; });
    request.emit("blocked");
    await Promise.resolve();
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    request.emit("success");
    await expect(deletion).resolves.toBeUndefined();
  });

  it("wraps an identity deletion IndexedDB error and preserves its cause", async () => {
    const request = createEventRequest();
    const sourceError = new Error("delete failed");
    request.error = sourceError;
    const deletion = deleteIdentityMemberCache(cacheIdentityFromContext(contextA), {
      indexedDBImpl: { deleteDatabase: () => request } as any
    });
    request.emit("error");
    await expect(deletion).rejects.toMatchObject({ code: "MEMBER_CACHE_DELETE_FAILED", cause: sourceError });
  });
});

describe("Member cache IndexedDB lifecycle", () => {
  it("closes the opened database exactly once on versionchange", async () => {
    const request = createEventRequest() as any;
    const database = {
      objectStoreNames: { contains: () => true },
      close: vi.fn(),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === "versionchange") request.versionchange = listener;
      })
    };
    request.result = database;
    const indexedDBImpl = { open: vi.fn(() => request) };
    const { openMemberCache } = await import("../member-public/cache.js");
    const opening = openMemberCache("family-ai-member-web-v2:test", { indexedDBImpl });
    request.emit("success");
    await opening;
    request.versionchange(); request.versionchange();
    expect(database.close).toHaveBeenCalledOnce();
    expect(indexedDBImpl.open).toHaveBeenCalledWith("family-ai-member-web-v2:test", 1);
  });
});
