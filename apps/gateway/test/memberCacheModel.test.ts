import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MEMBER_CACHE_STORES,
  applyEventTransaction,
  createMemoryCache,
  mergeThreadPage,
  readBootstrapSnapshot,
  removeOutgoing,
  replaceThreadMessages,
  saveDraft,
  saveOutgoing,
  saveProgress,
  saveWorks
} from "../member-public/cache.js";

const sourcePath = fileURLToPath(new URL("../member-public/cache.js", import.meta.url));

describe("Member Web cache model", () => {
  it("defines the disposable product projection stores", () => {
    expect(MEMBER_CACHE_STORES).toEqual([
      "meta",
      "threads",
      "messages",
      "works",
      "progress",
      "drafts",
      "outgoing"
    ]);
  });

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

    let snapshot = await readBootstrapSnapshot(cache);
    expect(snapshot).toMatchObject({
      works: [{ workConversationRef: "work:0001" }],
      progress: [{ workConversationRef: "work:0001" }],
      drafts: [{ threadRef: "thread:work-0001", text: "离线草稿" }],
      outgoing: [{ clientMessageId: "web:outgoing-0001", status: "failed" }]
    });

    await removeOutgoing(cache, "web:outgoing-0001");
    snapshot = await readBootstrapSnapshot(cache);
    expect(snapshot.outgoing).toEqual([]);
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
