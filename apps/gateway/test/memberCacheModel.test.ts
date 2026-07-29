import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MEMBER_CACHE_STORES,
  applyEventTransaction,
  clearMemberCache,
  createMemoryCache,
  enqueueOutgoingMessage,
  mergeThreadPage,
  openMemberCache,
  readBootstrapSnapshot,
  readAttachmentDrafts,
  removeAttachmentDraft,
  removeOutgoing,
  replaceThreadMessages,
  saveDraft,
  saveAttachmentDraft,
  saveMeta,
  saveOutgoing,
  saveProgress,
  saveWorks
} from "../member-public/cache.js";

const sourcePath = fileURLToPath(new URL("../member-public/cache.js", import.meta.url));

function fakeOpenRequest() {
  const listeners = new Map<string, Array<{ listener: () => void; once: boolean }>>();
  return {
    result: undefined as unknown,
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

describe("Member Web cache model", () => {
  it("defines the disposable product projection stores and browser opener", () => {
    expect(MEMBER_CACHE_STORES).toEqual([
      "meta",
      "threads",
      "messages",
      "works",
      "progress",
      "drafts",
      "attachmentDrafts",
      "outgoing"
    ]);
    expect(openMemberCache).toBeTypeOf("function");
  });

  it("opens caller-supplied cache names without replacing the temporary legacy default", async () => {
    const request = fakeOpenRequest();
    const database = {
      objectStoreNames: { contains: () => true },
      close() {},
      addEventListener() {}
    };
    request.result = database;
    const indexedDBImpl = { open: (name: string, version: number) => {
      expect(name).toBe("family-ai-member-web-v2:family:a:person:a:device:a");
      expect(version).toBe(2);
      return request;
    } };
    const opening = openMemberCache("family-ai-member-web-v2:family:a:person:a:device:a", { indexedDBImpl });
    request.emit("success");
    await expect(opening).resolves.toMatchObject({ close: expect.any(Function) });
  });

  it.each([undefined, "", 42])(
    "rejects the invalid cache name %j before IndexedDB is touched",
    async (databaseName) => {
      const indexedDBImpl = { open: vi.fn() };

      await expect(
        openMemberCache(databaseName as string, { indexedDBImpl })
      ).rejects.toMatchObject({
        code: "MEMBER_CACHE_NAME_REQUIRED",
        message: "Member cache name is required."
      });

      expect(indexedDBImpl.open).not.toHaveBeenCalled();
    }
  );

  it("commits event writes and localAppliedSequence in one transaction", async () => {
    const cache = createMemoryCache();
    const committed = await applyEventTransaction(cache, 1, async (transaction) => {
      await transaction.put("messages", {
        messageRef: "message:0001",
        threadRef: "thread:chat-0001",
        threadSequence: 1
      });
      await transaction.put("works", {
        workConversationRef: "work:0001",
        threadRef: "thread:work-0001"
      });
    });

    expect(committed).toBe(true);
    expect(await readBootstrapSnapshot(cache)).toMatchObject({
      localAppliedSequence: 1,
      messages: [{ messageRef: "message:0001" }],
      works: [{ workConversationRef: "work:0001" }]
    });
  });

  it("does not advance or retain partial writes when an event transaction fails", async () => {
    const cache = createMemoryCache();

    await expect(applyEventTransaction(cache, 1, async (transaction) => {
      await transaction.put("messages", {
        messageRef: "message:partial",
        threadRef: "thread:chat-0001",
        threadSequence: 1
      });
      throw new Error("RESOURCE_REFRESH_FAILED");
    })).rejects.toThrow("RESOURCE_REFRESH_FAILED");

    expect(await readBootstrapSnapshot(cache)).toMatchObject({
      localAppliedSequence: 0,
      messages: []
    });
  });

  it("treats replayed event sequences as idempotent without executing writes", async () => {
    const cache = createMemoryCache();
    await applyEventTransaction(cache, 1, async () => undefined);
    let called = false;
    const committed = await applyEventTransaction(cache, 1, async () => {
      called = true;
    });

    expect(committed).toBe(false);
    expect(called).toBe(false);
    expect((await readBootstrapSnapshot(cache)).localAppliedSequence).toBe(1);
  });

  it("replaces latest thread messages, merges older pages and keeps thread order", async () => {
    const cache = createMemoryCache();
    await replaceThreadMessages(cache, "thread:chat-0001", [
      { messageRef: "message:0002", threadRef: "thread:chat-0001", threadSequence: 2 },
      { messageRef: "message:0003", threadRef: "thread:chat-0001", threadSequence: 3 }
    ]);
    await mergeThreadPage(cache, "thread:chat-0001", [
      { messageRef: "message:0001", threadRef: "thread:chat-0001", threadSequence: 1 },
      { messageRef: "message:0002", threadRef: "thread:chat-0001", threadSequence: 2 }
    ]);

    const snapshot = await readBootstrapSnapshot(cache);
    expect(snapshot.messages.map((message: { messageRef: string }) => message.messageRef)).toEqual([
      "message:0001",
      "message:0002",
      "message:0003"
    ]);
  });

  it("persists current Work, progress, draft and outgoing projections", async () => {
    const cache = createMemoryCache();
    await saveWorks(cache, [
      { workConversationRef: "work:0001", threadRef: "thread:work-0001", lastActiveAt: "2026-07-25T10:00:00.000Z" }
    ]);
    await saveProgress(cache, {
      workConversationRef: "work:0001",
      phaseSummary: "正在推进",
      updatedAt: "2026-07-25T10:00:00.000Z"
    });
    await saveDraft(cache, "thread:work-0001", "离线草稿");
    await saveOutgoing(cache, {
      clientMessageId: "web:outgoing-0001",
      threadRef: "thread:work-0001",
      status: "failed"
    });
    await saveMeta(cache, "context", { person: { displayName: "Alice" } });

    let snapshot = await readBootstrapSnapshot(cache);
    expect(snapshot).toMatchObject({
      context: { person: { displayName: "Alice" } },
      works: [{ workConversationRef: "work:0001" }],
      progress: [{ workConversationRef: "work:0001" }],
      drafts: [{ threadRef: "thread:work-0001", text: "离线草稿" }],
      outgoing: [{ clientMessageId: "web:outgoing-0001", status: "failed" }]
    });

    await removeOutgoing(cache, "web:outgoing-0001");
    snapshot = await readBootstrapSnapshot(cache);
    expect(snapshot.outgoing).toEqual([]);

    await clearMemberCache(cache);
    expect(await readBootstrapSnapshot(cache)).toMatchObject({
      context: null,
      localAppliedSequence: 0,
      messages: [],
      works: [],
      progress: [],
      drafts: [],
      outgoing: []
    });
  });

  it("persists and projects attachment drafts by immutable Agent and Thread", async () => {
    const cache = createMemoryCache();
    const chatDraft = {
      attachmentRef: "attachment:chat-a",
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      fileName: "chat.pdf",
      mediaType: "application/pdf",
      sizeBytes: 100,
      serverState: "ready"
    };
    const workDraft = {
      ...chatDraft,
      attachmentRef: "attachment:work-a",
      threadRef: "thread:work-a",
      fileName: "work.pdf"
    };
    const otherAgentDraft = {
      ...chatDraft,
      attachmentRef: "attachment:chat-b",
      agentRef: "agent:b",
      threadRef: "thread:chat-b"
    };
    await saveAttachmentDraft(cache, chatDraft);
    await saveAttachmentDraft(cache, workDraft);
    await saveAttachmentDraft(cache, otherAgentDraft);

    expect(await readAttachmentDrafts(cache, {
      agentRef: "agent:a",
      threadRef: "thread:chat-a"
    })).toEqual([chatDraft]);
    expect((await readBootstrapSnapshot(cache, "agent:a")).attachmentDrafts)
      .toEqual([chatDraft, workDraft]);
    expect((await readBootstrapSnapshot(cache, "agent:b")).attachmentDrafts)
      .toEqual([otherAgentDraft]);

    await removeAttachmentDraft(cache, chatDraft.attachmentRef);
    expect(await readAttachmentDrafts(cache, {
      agentRef: "agent:a",
      threadRef: "thread:chat-a"
    })).toEqual([]);
  });

  it("atomically enqueues outgoing content and removes its text and attachment drafts", async () => {
    const cache = createMemoryCache();
    await saveDraft(cache, "thread:chat-a", "queued text", "agent:a");
    await saveAttachmentDraft(cache, {
      attachmentRef: "attachment:queued-a",
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      serverState: "ready"
    });
    const outgoing = {
      clientMessageId: "web:queued-a",
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      content: { type: "text", text: "queued text" },
      attachmentRefs: ["attachment:queued-a"],
      status: "sending"
    };

    await enqueueOutgoingMessage(cache, {
      outgoing,
      attachmentRefs: outgoing.attachmentRefs
    });

    expect(await readBootstrapSnapshot(cache)).toMatchObject({
      drafts: [],
      attachmentDrafts: [],
      outgoing: [outgoing]
    });
  });

  it("never persists Web Entry credentials in the browser cache module", () => {
    const source = readFileSync(sourcePath, "utf8");
    for (const forbidden of [
      "deviceCredential",
      "entryToken",
      "Authorization",
      "externalSessionRef",
      "pairingCode"
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
