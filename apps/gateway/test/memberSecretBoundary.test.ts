import { createServer, request as httpRequest, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../member-public/api.js";
import {
  capturePairingFragment,
  clearPendingClaim,
  isTerminalPairingError,
  shouldRetainPendingClaim
} from "../member-public/pairing.js";
import {
  MEMBER_CACHE_STORES,
  applyEventTransaction,
  createMemoryCache,
  openMemberCache,
  readBootstrapSnapshot
} from "../member-public/cache.js";
import {
  cacheIdentityFromContext,
  deleteIdentityMemberCache,
  memberCacheDatabaseName,
  openIdentityMemberCache
} from "../member-public/cache-identity.js";
import { createStore } from "../member-public/store.js";
import { createSyncController } from "../member-public/sync.js";
import {
  createEntryControllerHarness,
  createStorage,
  memberContextFixture
} from "./helpers/memberBrowserHarness.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const proxyPath = join(root, "scripts/member-preview-claim-loss-proxy.mjs");
const auditPath = join(
  root, "scripts/member-preview-secret-audit.mjs"
);
const installationId = "b53f0490-99f1-4d6c-9a95-921a3d76a8c3";
const rotatedInstallationId = "d39e5a44-362d-463d-8b51-0f326decbf8a";
const sentinels = {
  bootstrap: "Q".repeat(42) + "A",
  entry: "E".repeat(42) + "A",
  credential: "C".repeat(42) + "A",
  pairingCode: "ABCD-EFGH",
  handoff:
    "http://127.0.0.1:8791/member/#pairingRef=pairing%3Asecret-boundary&code=ABCD-EFGH"
};
const businessMessageBody = "BUSINESS-MESSAGE-BODY-SENTINEL-DO-NOT-BROADCAST";
const servers: Server[] = [];
const directories: string[] = [];

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function expectNoBoundaryLeaks(value: unknown): void {
  const bytes = serialized(value);
  for (const sentinel of Object.values(sentinels)) {
    expect(bytes).not.toContain(sentinel);
  }
  expect(bytes).not.toContain(businessMessageBody);
}

function credentialCrypto() {
  const bytes = Buffer.from(sentinels.credential, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== sentinels.credential) {
    throw new Error("INVALID_CREDENTIAL_SENTINEL");
  }
  return {
    getRandomValues<T extends ArrayBufferView>(target: T): T {
      const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
      if (view.byteLength !== bytes.length) throw new Error("UNEXPECTED_CREDENTIAL_SIZE");
      view.set(bytes);
      return target;
    }
  };
}

function capturePending(sessionStorage: ReturnType<typeof createStorage>) {
  const historyRef = {
    state: null,
    replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
      expect(url).toBe("/member/");
    })
  };
  const pending = capturePairingFragment({
    href: sentinels.handoff,
    historyRef,
    installationId,
    sessionStorage,
    cryptoImpl: credentialCrypto()
  });
  expect(historyRef.replaceState).toHaveBeenCalledOnce();
  return pending!;
}

function expectOnlyUnresolvedClaim(
  sessionStorage: ReturnType<typeof createStorage>,
  pending: unknown
): void {
  const values = Object.values(sessionStorage.dump());
  expect(values).toHaveLength(1);
  expect(JSON.parse(values[0]!)).toEqual(pending);
  expect(values[0]).toContain(sentinels.pairingCode);
  expect(values[0]).toContain(sentinels.credential);
  expect(values[0]).not.toContain(sentinels.bootstrap);
  expect(values[0]).not.toContain(sentinels.entry);
  expect(values[0]).not.toContain(sentinels.handoff);
  expect(values[0]).not.toContain(businessMessageBody);
}

function realPendingClaims(sessionStorage: ReturnType<typeof createStorage>) {
  return {
    clear: () => clearPendingClaim(sessionStorage),
    isTerminalError: isTerminalPairingError,
    shouldRetain: shouldRetainPendingClaim
  };
}

function createIdentityDatabaseRegistry() {
  type StoreState = {
    keyPath: string;
    records: Map<string, unknown>;
  };
  type DatabaseState = {
    stores: Map<string, StoreState>;
    connections: Set<{ closed: boolean }>;
  };
  const databases = new Map<string, DatabaseState>();

  function clone<T>(value: T): T {
    return value === undefined ? value : structuredClone(value);
  }

  function eventTarget() {
    const listeners = new Map<
      string,
      Array<{ listener: () => void; once: boolean }>
    >();
    return {
      addEventListener(
        type: string,
        listener: () => void,
        options?: { once?: boolean }
      ) {
        listeners.set(type, [
          ...(listeners.get(type) ?? []),
          { listener, once: options?.once === true }
        ]);
      },
      emit(type: string) {
        const entries = listeners.get(type) ?? [];
        for (const entry of entries) entry.listener();
        listeners.set(type, entries.filter(entry => !entry.once));
      }
    };
  }

  function createTransaction(state: DatabaseState, storeNames: string[]) {
    const events = eventTarget();
    let pending = 0;
    let generation = 0;
    let settled = false;
    let aborted = false;
    const transaction: any = {
      error: null,
      addEventListener: events.addEventListener,
      abort() {
        if (settled) return;
        aborted = true;
        settled = true;
        events.emit("abort");
      },
      objectStore(name: string) {
        if (!storeNames.includes(name)) throw new Error("STORE_NOT_IN_TRANSACTION");
        const store = state.stores.get(name);
        if (!store) throw new Error(`OBJECT_STORE_MISSING:${name}`);
        const operation = (run: () => unknown) => {
          const requestEvents = eventTarget();
          const request: any = {
            result: undefined,
            error: null,
            addEventListener: requestEvents.addEventListener
          };
          pending += 1;
          generation += 1;
          queueMicrotask(() => {
            if (aborted) return;
            try {
              request.result = clone(run());
              requestEvents.emit("success");
            } catch (error) {
              request.error = error;
              transaction.error = error;
              requestEvents.emit("error");
              events.emit("error");
            } finally {
              pending -= 1;
              scheduleCompletion();
            }
          });
          return request;
        };
        return {
          get(key: string) {
            return operation(() => store.records.get(key));
          },
          getAll() {
            return operation(() => [...store.records.values()]);
          },
          index(indexName: string) {
            return {
              getAll(value: string) {
                return operation(() =>
                  [...store.records.values()].filter(
                    (record: any) => record?.[indexName] === value
                  )
                );
              }
            };
          },
          put(value: Record<string, unknown>) {
            return operation(() => {
              const key = value?.[store.keyPath];
              if (typeof key !== "string" || key === "") {
                throw new Error(`OBJECT_STORE_KEY_INVALID:${name}`);
              }
              store.records.set(key, clone(value));
              return key;
            });
          },
          delete(key: string) {
            return operation(() => store.records.delete(key));
          },
          clear() {
            return operation(() => store.records.clear());
          }
        };
      }
    };
    function scheduleCompletion() {
      const expectedGeneration = generation;
      queueMicrotask(() => {
        if (
          !settled &&
          !aborted &&
          pending === 0 &&
          generation === expectedGeneration
        ) {
          settled = true;
          events.emit("complete");
        }
      });
    }
    scheduleCompletion();
    return transaction;
  }

  function databaseConnection(state: DatabaseState) {
    const events = eventTarget();
    const connection = {
      closed: false,
      objectStoreNames: {
        contains(name: string) {
          return state.stores.has(name);
        }
      },
      createObjectStore(name: string, options: { keyPath: string }) {
        if (state.stores.has(name)) throw new Error(`OBJECT_STORE_EXISTS:${name}`);
        const store: StoreState = {
          keyPath: options.keyPath,
          records: new Map()
        };
        state.stores.set(name, store);
        return {
          createIndex() {}
        };
      },
      addEventListener: events.addEventListener,
      transaction(storeNames: string[], mode: string) {
        if (connection.closed) throw new Error("DATABASE_CLOSED");
        if (mode !== "readwrite") throw new Error("TRANSACTION_MODE_INVALID");
        return createTransaction(state, storeNames);
      },
      close() {
        if (connection.closed) return;
        connection.closed = true;
        state.connections.delete(connection);
      }
    };
    state.connections.add(connection);
    return connection;
  }

  const indexedDBImpl = {
    open(name: string, version: number) {
      const events = eventTarget();
      const request: any = {
        result: undefined,
        error: null,
        addEventListener: events.addEventListener
      };
      queueMicrotask(() => {
        try {
          if (version !== 2) throw new Error("DATABASE_VERSION_INVALID");
          let state = databases.get(name);
          const created = !state;
          if (!state) {
            state = { stores: new Map(), connections: new Set() };
            databases.set(name, state);
          }
          request.result = databaseConnection(state);
          if (created) events.emit("upgradeneeded");
          events.emit("success");
        } catch (error) {
          request.error = error;
          events.emit("error");
        }
      });
      return request;
    },
    deleteDatabase(name: string) {
      const events = eventTarget();
      const request: any = {
        error: null,
        addEventListener: events.addEventListener
      };
      queueMicrotask(() => {
        const state = databases.get(name);
        if (state && [...state.connections].some(connection => !connection.closed)) {
          events.emit("blocked");
          return;
        }
        databases.delete(name);
        events.emit("success");
      });
      return request;
    }
  };

  return {
    databases,
    indexedDBImpl,
    openCache(name: string) {
      return openMemberCache(name, { indexedDBImpl: indexedDBImpl as any });
    },
    serializedIndexedDbBytes() {
      return JSON.stringify(
        [...databases.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, database]) => ({
            name,
            stores: [...database.stores.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([storeName, store]) => ({
                name: storeName,
                records: [...store.records.entries()]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([key, value]) => ({ key, value: clone(value) }))
              }))
          }))
      );
    }
  };
}

class BoundaryEventSource {
  static instances: BoundaryEventSource[] = [];
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    BoundaryEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data: unknown, lastEventId = "") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }
  close() {
    this.closed = true;
  }
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LISTEN_FAILED");
  expect([8790, 8791, 8792]).not.toContain(address.port);
  return address.port;
}

function droppedClaim(port: number, body: string, cookie: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/v1/web-entry/pairing/claim",
      headers: {
        cookie,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body))
      }
    }, response => {
      response.resume();
      response.once("end", () => resolve());
      response.once("error", reject);
    });
    client.once("error", reject);
    client.end(body);
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  BoundaryEventSource.instances = [];
});

describe("Member Web five-sentinel boundary", () => {
  it("keeps schema-valid sentinels out of PublicError and ordinary JSON", async () => {
    expect(sentinels.bootstrap).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
    expect(sentinels.entry).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
    expect(sentinels.credential).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
    expect(sentinels.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
    expect(new URL(sentinels.handoff).hash).toContain("pairingRef=");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/portal/context") {
        return new Response(JSON.stringify(memberContextFixture()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({
          code: "PAIRING_INVALID",
          category: "validation",
          message: "配对信息无效。",
          retryable: false,
          bootstrapToken: sentinels.bootstrap,
          entryToken: sentinels.entry,
          deviceCredential: sentinels.credential,
          pairingCode: sentinels.pairingCode,
          handoff: sentinels.handoff
        }),
        { status: 400 }
      );
    });
    const api = createApiClient(fetchImpl as typeof fetch);
    const error = await api.listWorks().then(
      () => {
        throw new Error("EXPECTED_REJECTION");
      },
      value => value
    );
    expect(error).toMatchObject({
      name: "GatewayError",
      status: 400,
      code: "PAIRING_INVALID",
      category: "validation",
      message: "配对信息无效。",
      retryable: false
    });
    expectNoBoundaryLeaks(error);
    const ordinary = await api.getWebContext();
    expect(ordinary).toEqual({
      protocolVersion: 2,
      context: memberContextFixture()
    });
    expectNoBoundaryLeaks(ordinary);
  });

  it("keeps only the unresolved Claim in SessionStorage and clears it on success", async () => {
    const sessionStorage = createStorage();
    const pending = capturePending(sessionStorage);
    expectOnlyUnresolvedClaim(sessionStorage, pending);
    const identityDatabases = createIdentityDatabaseRegistry();
    let openedCache: Awaited<ReturnType<typeof openMemberCache>> | undefined;
    const env = createEntryControllerHarness({
      installationId,
      rotatedInstallationId,
      pendingClaims: realPendingClaims(sessionStorage),
      workbench: {
        start: vi.fn(async (context: unknown) => {
          const opened = await openIdentityMemberCache(context, {
            openCache: identityDatabases.openCache
          });
          openedCache = opened.cache;
          return true;
        }),
        stop: vi.fn(async () => {
          openedCache?.close();
        })
      }
    });
    const controller = env.createController();

    await controller.bootstrap({ pendingClaim: pending });
    expect(env.api.claimWebPairing).toHaveBeenCalledWith(
      { ...pending, device: env.deviceDescriptor },
      { signal: expect.any(AbortSignal) }
    );
    expect(controller.getState()).toMatchObject({ name: "active" });
    expect(sessionStorage.dump()).toEqual({});
    expect(env.channels.posted.map((message: any) => message.type)).toEqual([
      "session-restored"
    ]);
    expectNoBoundaryLeaks(env.channels.posted);
    expectNoBoundaryLeaks(env.localStorage.dump());
    expect(openedCache).toBeDefined();
    const expectedDatabaseName = memberCacheDatabaseName(
      cacheIdentityFromContext(memberContextFixture())
    );
    const indexedDbBytes = identityDatabases.serializedIndexedDbBytes();
    const indexedDbSnapshot = JSON.parse(indexedDbBytes);
    expect(indexedDbSnapshot).toHaveLength(1);
    expect(indexedDbSnapshot[0].name).toBe(expectedDatabaseName);
    expect(
      indexedDbSnapshot[0].stores.map((store: any) => store.name).sort()
    ).toEqual([...MEMBER_CACHE_STORES].sort());
    const metaStore = indexedDbSnapshot[0].stores.find(
      (store: any) => store.name === "meta"
    );
    expect(metaStore.records).toContainEqual({
      key: "context",
      value: { key: "context", value: memberContextFixture() }
    });
    expect(indexedDbBytes).toContain(expectedDatabaseName);
    for (const storeName of MEMBER_CACHE_STORES) {
      expect(indexedDbBytes).toContain(storeName);
    }
    expectNoBoundaryLeaks(indexedDbBytes);
    expectNoBoundaryLeaks(await readBootstrapSnapshot(openedCache!));
    await controller.destroy();
  });

  it("clears SessionStorage and exposes only a fixed PublicError after terminal Claim rejection", async () => {
    const sessionStorage = createStorage();
    const pending = capturePending(sessionStorage);
    expectOnlyUnresolvedClaim(sessionStorage, pending);
    const terminal = Object.assign(new Error(sentinels.handoff), {
      code: "PAIRING_INVALID",
      category: "validation",
      retryable: false,
      claimOutcome: "rejected",
      bootstrapToken: sentinels.bootstrap,
      entryToken: sentinels.entry,
      deviceCredential: sentinels.credential,
      pairingCode: sentinels.pairingCode,
      businessMessageBody
    });
    const env = createEntryControllerHarness({
      installationId,
      rotatedInstallationId,
      pendingClaims: realPendingClaims(sessionStorage),
      api: {
        claimWebPairing: vi.fn(async () => {
          throw terminal;
        })
      }
    });
    const controller = env.createController();

    await controller.bootstrap({ pendingClaim: pending });
    expect(sessionStorage.dump()).toEqual({});
    expect(controller.getState()).toMatchObject({
      name: "unpaired",
      code: "GATEWAY_UNAVAILABLE",
      message: "服务暂时不可用，请重试。"
    });
    expectNoBoundaryLeaks(controller.getState());
    expectNoBoundaryLeaks(env.localStorage.dump());
    expectNoBoundaryLeaks(env.channels.posted);
    await controller.destroy();
  });

  it("removes the identity database and all browser secret carriers during Revoke cleanup", async () => {
    const sessionStorage = createStorage();
    const pending = capturePending(sessionStorage);
    const context = memberContextFixture();
    const identity = cacheIdentityFromContext(context);
    const identityDatabases = createIdentityDatabaseRegistry();
    let openedCache: Awaited<ReturnType<typeof openMemberCache>> | undefined;
    const env = createEntryControllerHarness({
      installationId,
      rotatedInstallationId,
      context,
      initialIdentity: identity,
      pendingClaims: realPendingClaims(sessionStorage),
      workbench: {
        start: vi.fn(async (activeContext: unknown) => {
          const opened = await openIdentityMemberCache(activeContext, {
            openCache: identityDatabases.openCache
          });
          openedCache = opened.cache;
          return true;
        }),
        stop: vi.fn(async () => {
          openedCache?.close();
        })
      },
      cacheLifecycle: {
        deleteIdentity: vi.fn((target: unknown, options: { onBlocked?: () => void } = {}) =>
          deleteIdentityMemberCache(target, {
            indexedDBImpl: identityDatabases.indexedDBImpl,
            onBlocked: options.onBlocked
          })
        )
      }
    });
    const controller = env.createController();

    await controller.bootstrap({ pendingClaim: pending });
    expect(identityDatabases.databases.has(memberCacheDatabaseName(identity))).toBe(true);
    const identityBytesBeforeRevoke =
      identityDatabases.serializedIndexedDbBytes();
    expect(identityBytesBeforeRevoke).toContain(memberCacheDatabaseName(identity));
    expectNoBoundaryLeaks(identityBytesBeforeRevoke);
    expectNoBoundaryLeaks(await readBootstrapSnapshot(openedCache!));
    await controller.removeDevice();

    expect(env.api.revokeWebDevice).toHaveBeenCalledOnce();
    expect(env.api.clearWebEntryCookies).toHaveBeenCalledOnce();
    expect(identityDatabases.databases.has(memberCacheDatabaseName(identity))).toBe(false);
    const identityBytesAfterRevoke =
      identityDatabases.serializedIndexedDbBytes();
    expect(identityBytesAfterRevoke).toBe("[]");
    expectNoBoundaryLeaks(identityBytesAfterRevoke);
    expect(env.storage.readIdentityPointer(installationId)).toBeNull();
    expect(env.storage.readInstallationId()).toBe(rotatedInstallationId);
    expect(sessionStorage.dump()).toEqual({});
    expect(env.channels.posted.map((message: any) => message.type)).toEqual([
      "session-restored",
      "device-revoke-preparing",
      "device-revoke-complete"
    ]);
    expectNoBoundaryLeaks(env.channels.posted);
    expectNoBoundaryLeaks(env.localStorage.dump());
    await controller.destroy();
  });

  it("broadcasts only a projection wake-up while excluding a business body and all five sentinels", async () => {
    BoundaryEventSource.instances = [];
    const projectionMessages: unknown[] = [];
    class ProjectionChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(message: unknown) {
        projectionMessages.push(structuredClone(message));
      }
      close() {}
    }
    const cache = createMemoryCache();
    const store = createStore({
      sync: {
        status: "idle",
        localAppliedSequence: 0,
        acknowledgedSequence: 0,
        latestSequence: 0,
        error: null
      }
    });
    const api = {
      getSyncEvents: vi.fn(async () => ({
        protocolVersion: 1,
        sync: {
          deviceRef: "device:web-alice",
          personRef: "person:alice",
          acknowledgedSequence: 0,
          requestedAfterSequence: 0,
          latestSequence: 0
        },
        events: [],
        nextAfterSequence: null
      })),
      ackSyncEvent: vi.fn(async () => ({ protocolVersion: 1 }))
    };
    const controller = createSyncController({
      api,
      cache,
      store,
      applyEvent: async (event: { eventSequence: number }) => {
        await applyEventTransaction(cache, event.eventSequence, async () => undefined);
      },
      EventSourceClass: BoundaryEventSource,
      BroadcastChannelClass: ProjectionChannel,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined
    });
    await controller.start();
    const source = BoundaryEventSource.instances[0]!;
    source.emit("domain-event", {
      eventRef: "event:secret-boundary",
      personRef: "person:alice",
      eventSequence: 1,
      eventType: "thread.message.created",
      aggregateType: "thread",
      aggregateRef: "thread:chat-0001",
      threadRef: "thread:chat-0001",
      payload: {
        message: {
          body: businessMessageBody,
          bootstrapToken: sentinels.bootstrap,
          entryToken: sentinels.entry,
          deviceCredential: sentinels.credential,
          pairingCode: sentinels.pairingCode,
          handoff: sentinels.handoff
        }
      },
      occurredAt: "2026-07-27T00:00:00.000Z",
      createdAt: "2026-07-27T00:00:00.000Z"
    }, "1");

    await controller.whenIdle();

    expect(projectionMessages).toEqual([{ type: "cache-updated", eventSequence: 1 }]);
    expectNoBoundaryLeaks(projectionMessages);
    expectNoBoundaryLeaks(await readBootstrapSnapshot(cache));
    await controller.stop();
  });
  it("uses a fresh installation and removes each audit device across repeated runs", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "member-secret-audit-reentry-"));
    directories.push(runtimeDir);
    const configDir = join(runtimeDir, "config");
    mkdirSync(configDir, { recursive: true });
    const origin = "http://127.0.0.1:8791";
    const admin = {
      version: 1,
      origin,
      familyRef: "family:audit",
      personRef: "person:audit",
      deviceRef: "device:audit-admin",
      entryBindingRef: "entry-binding:audit-admin",
      entrySessionRef: "entry-session:audit-admin",
      token: `${"A".repeat(42)}A`
    };
    writeFileSync(
      join(configDir, "admin-entry.json"),
      `${JSON.stringify(admin)}\n`
    );
    writeFileSync(join(configDir, "device-token"), `${"B".repeat(42)}A\n`);

    const auditCredential = `${"S".repeat(42)}A`;
    const auditEntryToken = `${"T".repeat(42)}A`;
    const installationIds: string[] = [];
    const activeInstallations = new Map<string, string>();
    let pairingCount = 0;
    let revokeCount = 0;
    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      });
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const requestUrl = new URL(String(input));
        const method = init.method ?? "GET";
        const headers = new Headers(init.headers);
        const requestBody =
          typeof init.body === "string" ? JSON.parse(init.body) : null;

        if (
          method === "GET" &&
          requestUrl.pathname === "/api/v1/onboarding/status"
        ) {
          return jsonResponse({ initialized: true });
        }
        if (
          method === "GET" &&
          requestUrl.pathname === "/api/v1/portal/context"
        ) {
          return jsonResponse({
            protocolVersion: 1,
            audience: "family_admin",
            entrySessionRef: admin.entrySessionRef,
            entryBindingRef: admin.entryBindingRef,
            family: {
              familyRef: admin.familyRef,
              displayName: "Audit Family"
            },
            person: {
              personRef: admin.personRef,
              displayName: "Audit Person"
            },
            membership: { familyRole: "owner" },
            device: {
              deviceRef: admin.deviceRef,
              displayName: "Audit Admin",
              terminalType: "desktop",
              platform: "linux"
            },
            agent: {
              assignmentRef: "assignment:audit",
              assignmentType: "family",
              agentRef: "agent:family-manager",
              displayName: "Family Manager",
              providerProfileRef: null
            }
          });
        }
        if (
          method === "POST" &&
          requestUrl.pathname.endsWith("/pairing-codes")
        ) {
          pairingCount += 1;
          const pairingRef = `pairing:audit-${pairingCount}`;
          const code = pairingCount === 1 ? "ABCD-EFGH" : "JKLM-NPQR";
          const expiresAt = new Date(Date.now() + 300_000).toISOString();
          return jsonResponse({
            protocolVersion: 1,
            pairing: {
              pairingRef,
              code,
              expiresAt,
              status: "active"
            },
            family: { displayName: "Audit Family" },
            person: { displayName: "Audit Person" },
            qr: {
              payload: {
                version: 1,
                gateway: origin,
                pairingRef,
                code,
                expiresAt
              },
              url: `${origin}/member/`
            }
          }, 201);
        }
        if (
          method === "POST" &&
          requestUrl.pathname === "/api/v1/web-entry/pairing/claim" &&
          requestBody?.hostile
        ) {
          return jsonResponse({
            protocolVersion: 2,
            error: {
              code: "INVALID_REQUEST",
              category: "validation",
              message: "请求无效。",
              retryable: false,
              requestId: "request:audit"
            }
          }, 400);
        }
        if (
          method === "POST" &&
          requestUrl.pathname === "/api/v1/web-entry/pairing/claim"
        ) {
          const installationId = requestBody?.installationId;
          if (
            typeof installationId !== "string" ||
            activeInstallations.has(installationId)
          ) {
            return jsonResponse({
              protocolVersion: 2,
              error: {
                code: "DEVICE_AUTH_INVALID",
                category: "permission",
                message: "浏览器设备凭证无效。",
                retryable: false,
                requestId: "request:audit"
              }
            }, 401);
          }
          installationIds.push(installationId);
          const deviceRef = `device:audit-${installationIds.length}`;
          activeInstallations.set(installationId, deviceRef);
          const cookieLines: Array<[string, string]> = [
            ["set-cookie", `family_ai_web_device_ref=${deviceRef}; HttpOnly`],
            ["set-cookie", `family_ai_web_device_credential=${auditCredential}; HttpOnly`],
            ["set-cookie", `family_ai_web_entry_session_ref=entry-session:audit-${installationIds.length}; HttpOnly`],
            ["set-cookie", `family_ai_web_entry_token=${auditEntryToken}; HttpOnly`]
          ];
          return new Response(null, { status: 204, headers: cookieLines });
        }
        if (
          method === "GET" &&
          requestUrl.pathname === "/api/v1/web-entry/context"
        ) {
          return jsonResponse({
            protocolVersion: 1,
            context: { status: "active" }
          });
        }
        if (
          method === "DELETE" &&
          requestUrl.pathname === "/api/v1/web-entry/device"
        ) {
          const cookie = headers.get("cookie") ?? "";
          const active = [...activeInstallations.entries()].find(
            ([, deviceRef]) =>
              cookie.includes(`family_ai_web_device_ref=${encodeURIComponent(deviceRef)}`)
          );
          if (!active || headers.get("x-family-ai-web-request") !== "1") {
            return jsonResponse({
              protocolVersion: 2,
              error: {
                code: "DEVICE_AUTH_INVALID",
                category: "permission",
                message: "浏览器设备凭证无效。",
                retryable: false,
                requestId: "request:audit"
              }
            }, 401);
          }
          activeInstallations.delete(active[0]);
          revokeCount += 1;
          return jsonResponse({
            protocolVersion: 2,
            status: "revoked"
          });
        }
        throw new Error(`UNEXPECTED_AUDIT_REQUEST:${method}:${requestUrl.pathname}`);
      }
    );
    const { runPreviewSecretAudit } = await import(
      `${pathToFileURL(auditPath).href}?reentry=${Date.now()}`
    );

    await expect(runPreviewSecretAudit({
      origin,
      runtimeDir,
      fetchImpl
    })).resolves.toBe("Preview secret audit: PASS");
    await expect(runPreviewSecretAudit({
      origin,
      runtimeDir,
      fetchImpl
    })).resolves.toBe("Preview secret audit: PASS");

    expect(installationIds).toHaveLength(2);
    expect(new Set(installationIds).size).toBe(2);
    for (const value of installationIds) {
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      );
    }
    expect(revokeCount).toBe(2);
    expect(activeInstallations.size).toBe(0);
  });

  it("keeps proxy log records fixed-shape and excludes request, Cookie and Set-Cookie sentinels", async () => {
    const directory = mkdtempSync(join(tmpdir(), "member-secret-boundary-proxy-"));
    directories.push(directory);
    const logs: unknown[] = [];
    const upstream = createServer((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(204, [
          "set-cookie", `bootstrap=${sentinels.bootstrap}; HttpOnly`,
          "set-cookie", `entry=${sentinels.entry}; HttpOnly`
        ]);
        response.end();
      });
    });
    const upstreamPort = await listen(upstream);
    const { createClaimLossProxy } = await import(
      `${pathToFileURL(proxyPath).href}?secret-boundary=${Date.now()}`
    );
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile: join(directory, "claim-loss-state.json"),
      log(record: unknown) {
        logs.push(record);
      }
    });
    const proxyPort = await listen(proxy);
    const requestBody = JSON.stringify({
      bootstrapToken: sentinels.bootstrap,
      entryToken: sentinels.entry,
      deviceCredential: sentinels.credential,
      pairingRef: "pairing:secret-boundary",
      pairingCode: sentinels.pairingCode,
      handoff: sentinels.handoff,
      businessMessageBody
    });

    await expect(droppedClaim(
      proxyPort,
      requestBody,
      `family_ai_entry=${sentinels.entry}; family_ai_device=${sentinels.credential}`
    )).rejects.toBeTruthy();
    await new Promise(resolve => setImmediate(resolve));
    expect(logs.length).toBeGreaterThan(0);
    expectNoBoundaryLeaks(logs);
    for (const record of logs as Array<Record<string, unknown>>) {
      expect(Object.keys(record).sort()).toEqual(["event", "requestId", "timestamp"]);
      expect(record).not.toHaveProperty("url");
      expect(record).not.toHaveProperty("headers");
      expect(record).not.toHaveProperty("body");
    }
  });
});
