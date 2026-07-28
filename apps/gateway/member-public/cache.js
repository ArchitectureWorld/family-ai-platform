export const MEMBER_CACHE_STORES = [
  "meta",
  "threads",
  "messages",
  "works",
  "progress",
  "drafts",
  "outgoing"
];

export const LEGACY_DATABASE_NAME = "family-ai-member-web";
const DATABASE_VERSION = 1;
const KEY_PATHS = {
  meta: "key",
  threads: "threadRef",
  messages: "messageRef",
  works: "workConversationRef",
  progress: "workConversationRef",
  drafts: "threadRef",
  outgoing: "clientMessageId"
};

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function keyFor(storeName, value) {
  const keyPath = KEY_PATHS[storeName];
  const key = value?.[keyPath];
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`CACHE_KEY_INVALID:${storeName}`);
  }
  return key;
}

function sortMessages(messages) {
  return [...messages].sort((left, right) => {
    const thread = String(left.threadRef).localeCompare(String(right.threadRef));
    if (thread !== 0) return thread;
    return Number(left.threadSequence) - Number(right.threadSequence);
  });
}

function sortWorks(works) {
  return [...works].sort((left, right) => {
    const leftTime = Date.parse(left.lastActiveAt ?? "") || 0;
    const rightTime = Date.parse(right.lastActiveAt ?? "") || 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return String(left.workConversationRef).localeCompare(String(right.workConversationRef));
  });
}

function createMemoryTransaction(state) {
  return {
    async get(storeName, key) {
      return clone(state.get(storeName)?.get(key));
    },
    async getAll(storeName) {
      return [...(state.get(storeName)?.values() ?? [])].map(clone);
    },
    async getAllByIndex(storeName, indexName, value) {
      return [...(state.get(storeName)?.values() ?? [])]
        .filter((item) => item?.[indexName] === value)
        .map(clone);
    },
    async put(storeName, value) {
      state.get(storeName).set(keyFor(storeName, value), clone(value));
    },
    async delete(storeName, key) {
      state.get(storeName).delete(key);
    },
    async clear(storeName) {
      state.get(storeName).clear();
    }
  };
}

export function createMemoryCache() {
  let state = new Map(MEMBER_CACHE_STORES.map((name) => [name, new Map()]));
  return {
    async transaction(_storeNames, callback) {
      const working = new Map(
        [...state.entries()].map(([name, values]) => [
          name,
          new Map([...values.entries()].map(([key, value]) => [key, clone(value)]))
        ])
      );
      const result = await callback(createMemoryTransaction(working));
      state = working;
      return result;
    },
    close() {}
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("INDEXED_DB_REQUEST_FAILED")), {
      once: true
    });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("INDEXED_DB_ABORTED")), {
      once: true
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("INDEXED_DB_FAILED")), {
      once: true
    });
  });
}

function createIndexedTransaction(transaction) {
  return {
    async get(storeName, key) {
      return requestResult(transaction.objectStore(storeName).get(key));
    },
    async getAll(storeName) {
      return requestResult(transaction.objectStore(storeName).getAll());
    },
    async getAllByIndex(storeName, indexName, value) {
      return requestResult(transaction.objectStore(storeName).index(indexName).getAll(value));
    },
    async put(storeName, value) {
      await requestResult(transaction.objectStore(storeName).put(value));
    },
    async delete(storeName, key) {
      await requestResult(transaction.objectStore(storeName).delete(key));
    },
    async clear(storeName) {
      await requestResult(transaction.objectStore(storeName).clear());
    }
  };
}

export async function openMemberCache(
  databaseName,
  { indexedDBImpl = globalThis.indexedDB } = {}
) {
  if (typeof databaseName !== "string" || databaseName.length === 0) {
    const error = new Error("Member cache name is required.");
    error.code = "MEMBER_CACHE_NAME_REQUIRED";
    throw error;
  }
  if (!indexedDBImpl) throw new Error("INDEXED_DB_UNAVAILABLE");
  const request = indexedDBImpl.open(databaseName, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("meta")) {
      database.createObjectStore("meta", { keyPath: "key" });
    }
    if (!database.objectStoreNames.contains("threads")) {
      database.createObjectStore("threads", { keyPath: "threadRef" });
    }
    if (!database.objectStoreNames.contains("messages")) {
      const store = database.createObjectStore("messages", { keyPath: "messageRef" });
      store.createIndex("threadRef", "threadRef", { unique: false });
      store.createIndex("threadSequence", ["threadRef", "threadSequence"], { unique: true });
    }
    if (!database.objectStoreNames.contains("works")) {
      database.createObjectStore("works", { keyPath: "workConversationRef" });
    }
    if (!database.objectStoreNames.contains("progress")) {
      database.createObjectStore("progress", { keyPath: "workConversationRef" });
    }
    if (!database.objectStoreNames.contains("drafts")) {
      database.createObjectStore("drafts", { keyPath: "threadRef" });
    }
    if (!database.objectStoreNames.contains("outgoing")) {
      const store = database.createObjectStore("outgoing", { keyPath: "clientMessageId" });
      store.createIndex("threadRef", "threadRef", { unique: false });
    }
  });
  const database = await requestResult(request);
  let closedForVersionChange = false;
  database.addEventListener("versionchange", () => {
    if (closedForVersionChange) return;
    closedForVersionChange = true;
    database.close();
  });

  return {
    async transaction(storeNames, callback) {
      const transaction = database.transaction([...new Set(storeNames)], "readwrite");
      const completion = transactionComplete(transaction);
      try {
        const result = await callback(createIndexedTransaction(transaction));
        await completion;
        return result;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be inactive after an IndexedDB error.
        }
        await completion.catch(() => undefined);
        throw error;
      }
    },
    close() {
      database.close();
    }
  };
}

export async function readBootstrapSnapshot(cache, agentRef = null) {
  return cache.transaction(MEMBER_CACHE_STORES, async (transaction) => {
    const [
      contextRecord,
      sequenceRecord,
      selectedSectionRecord,
      selectedWorkRecord,
      selectedAgentRecord,
      chatRecord,
      threads,
      messages,
      works,
      progress,
      drafts,
      outgoing
    ] = await Promise.all([
      transaction.get("meta", "context"),
      transaction.get("meta", "localAppliedSequence"),
      transaction.get("meta", "selectedSection"),
      transaction.get(
        "meta",
        agentRef ? `selectedWorkRef:${agentRef}` : "selectedWorkRef"
      ),
      transaction.get("meta", "selectedAgentRef"),
      agentRef
        ? transaction.get("meta", `chat:${agentRef}`)
        : Promise.resolve(null),
      transaction.getAll("threads"),
      transaction.getAll("messages"),
      transaction.getAll("works"),
      transaction.getAll("progress"),
      transaction.getAll("drafts"),
      transaction.getAll("outgoing")
    ]);
    const projectedWorks = agentRef
      ? works.filter((work) => work.agentRef === agentRef)
      : works;
    const allowedThreadRefs = new Set([
      ...projectedWorks.map((work) => work.threadRef),
      ...(chatRecord?.value?.chat?.threadRef
        ? [chatRecord.value.chat.threadRef]
        : [])
    ]);
    const projectByThread = (items) => !agentRef
      ? items
      : items.filter((item) =>
          item.agentRef === agentRef || allowedThreadRefs.has(item.threadRef)
        );
    const projectedWorkRefs = new Set(
      projectedWorks.map((work) => work.workConversationRef)
    );
    return {
      context: contextRecord?.value ?? null,
      localAppliedSequence: Number(sequenceRecord?.value ?? 0),
      selectedSection: selectedSectionRecord?.value === "work" ? "work" : "chat",
      selectedWorkRef: typeof selectedWorkRecord?.value === "string"
        ? selectedWorkRecord.value
        : null,
      ...(agentRef
        ? {
            selectedAgentRef: typeof selectedAgentRecord?.value === "string"
              ? selectedAgentRecord.value
              : null,
            chat: chatRecord?.value ?? null
          }
        : {}),
      threads: projectByThread(threads),
      messages: sortMessages(projectByThread(messages)),
      works: sortWorks(projectedWorks),
      progress: agentRef
        ? progress.filter((item) => projectedWorkRefs.has(item.workConversationRef))
        : progress,
      drafts: projectByThread(drafts),
      outgoing: projectByThread(outgoing)
    };
  });
}

export async function readSelectedAgentRef(cache) {
  return cache.transaction(["meta"], async (transaction) => {
    const record = await transaction.get("meta", "selectedAgentRef");
    return typeof record?.value === "string" ? record.value : null;
  });
}

export async function saveMeta(cache, key, value) {
  return cache.transaction(["meta"], (transaction) =>
    transaction.put("meta", { key, value: clone(value) })
  );
}

export async function replaceThreadMessages(cache, threadRef, messages) {
  return cache.transaction(["messages"], async (transaction) => {
    const existing = await transaction.getAllByIndex("messages", "threadRef", threadRef);
    for (const message of existing) await transaction.delete("messages", message.messageRef);
    for (const message of messages) await transaction.put("messages", message);
  });
}

export async function mergeThreadPage(cache, _threadRef, messages) {
  return cache.transaction(["messages"], async (transaction) => {
    for (const message of messages) await transaction.put("messages", message);
  });
}

export async function saveWorksForAgent(cache, agentRef, works) {
  return cache.transaction(["works"], async (transaction) => {
    const all = await transaction.getAll("works");
    for (const work of all) {
      if (work.agentRef === agentRef) {
        await transaction.delete("works", work.workConversationRef);
      }
    }
    for (const work of works) {
      await transaction.put("works", { ...work, agentRef });
    }
  });
}

// Compatibility for pre-Agent cache tests and one-time legacy migrations.
export async function saveWorks(cache, works) {
  return cache.transaction(["works"], async (transaction) => {
    await transaction.clear("works");
    for (const work of works) await transaction.put("works", work);
  });
}

export async function saveProgress(cache, snapshot) {
  return cache.transaction(["progress"], (transaction) => transaction.put("progress", snapshot));
}

export async function saveDraft(cache, threadRef, text, agentRef = null) {
  return cache.transaction(["drafts"], async (transaction) => {
    if (text.length === 0) {
      await transaction.delete("drafts", threadRef);
      return;
    }
    await transaction.put("drafts", {
      threadRef,
      ...(agentRef ? { agentRef } : {}),
      text,
      updatedAt: new Date().toISOString()
    });
  });
}

export async function saveOutgoing(cache, outgoing) {
  return cache.transaction(["outgoing"], (transaction) => transaction.put("outgoing", outgoing));
}

export async function removeOutgoing(cache, clientMessageId) {
  return cache.transaction(["outgoing"], (transaction) =>
    transaction.delete("outgoing", clientMessageId)
  );
}

export async function applyEventTransaction(cache, eventSequence, writes) {
  return cache.transaction(MEMBER_CACHE_STORES, async (transaction) => {
    const currentRecord = await transaction.get("meta", "localAppliedSequence");
    const current = Number(currentRecord?.value ?? 0);
    if (eventSequence <= current) return false;
    if (eventSequence !== current + 1) throw new Error("SYNC_SEQUENCE_GAP");
    await writes(transaction);
    await transaction.put("meta", { key: "localAppliedSequence", value: eventSequence });
    return true;
  });
}

export async function clearMemberCache(cache) {
  return cache.transaction(MEMBER_CACHE_STORES, async (transaction) => {
    for (const storeName of MEMBER_CACHE_STORES) await transaction.clear(storeName);
  });
}
