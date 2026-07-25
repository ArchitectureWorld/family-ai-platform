import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MEMBER_CACHE_STORES,
  applyEventTransaction,
  createMemoryCache,
  readBootstrapSnapshot
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
