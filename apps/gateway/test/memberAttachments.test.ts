import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  createAttachmentController
} from "../member-public/attachments.js";
import {
  createMemoryCache,
  readAttachmentDrafts,
  saveAttachmentDraft
} from "../member-public/cache.js";
import { createStore } from "../member-public/store.js";

const CHUNK_BYTES = 8 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeFile(size: number, name = "report.pdf") {
  return {
    name,
    type: "application/pdf",
    size,
    slice: vi.fn()
  };
}

function fixture(options: {
  receivedChunkIndexes?: number[];
  failChunkIndex?: number;
} = {}) {
  const cache = createMemoryCache();
  const store = createStore({ attachmentDrafts: [] });
  const chunks: Array<{
    attachmentRef: string;
    chunkIndex: number;
    blob: Blob;
    sha256: string;
  }> = [];
  const api = {
    beginAttachmentUpload: vi.fn(async (metadata) => ({
      protocolVersion: 1,
      attachmentRef: "attachment:upload-001",
      chunkBytes: CHUNK_BYTES,
      chunkCount: Math.ceil(metadata.sizeBytes / CHUNK_BYTES),
      receivedChunkIndexes: options.receivedChunkIndexes ?? [],
      expiresAt: "2026-07-30T00:00:00.000Z"
    })),
    putAttachmentChunk: vi.fn(async (
      attachmentRef,
      chunkIndex,
      blob,
      chunkSha256
    ) => {
      if (chunkIndex === options.failChunkIndex) throw new Error("CHUNK_FAILED");
      chunks.push({ attachmentRef, chunkIndex, blob, sha256: chunkSha256 });
      return {
        protocolVersion: 1,
        attachmentRef,
        chunkIndex,
        receivedBytes: blob.size,
        sha256: chunkSha256,
        replayed: false
      };
    }),
    completeAttachmentUpload: vi.fn(async (attachmentRef, command) => ({
      protocolVersion: 1,
      attachment: {
        attachmentRef,
        fileName: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1,
        sha256: command.sha256,
        downloadUrl: `/api/v1/attachments/${encodeURIComponent(attachmentRef)}`
      }
    })),
    cancelAttachmentUpload: vi.fn(async () => null)
  };
  const controller = createAttachmentController({
    api,
    cache,
    store,
    cryptoImpl: webcrypto,
    now: () => new Date("2026-07-29T09:00:00.000Z")
  });
  return { api, cache, chunks, controller, store };
}

describe("Member attachment controller", () => {
  it("rejects file, count, and total limits before starting a network request", async () => {
    const { api, cache, controller } = fixture();
    await expect(controller.addFiles({
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      files: [fakeFile(MAX_FILE_BYTES + 1)]
    })).rejects.toMatchObject({ code: "ATTACHMENT_SIZE_INVALID" });
    await expect(controller.addFiles({
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      files: Array.from(
        { length: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
        () => fakeFile(1)
      )
    })).rejects.toMatchObject({ code: "ATTACHMENT_COUNT_EXCEEDED" });

    await saveAttachmentDraft(cache, {
      attachmentRef: "attachment:oversized-existing",
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      fileName: "existing.pdf",
      mediaType: "application/pdf",
      sizeBytes: MAX_MESSAGE_ATTACHMENT_BYTES,
      serverState: "ready"
    });
    await expect(controller.addFiles({
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      files: [fakeFile(1)]
    })).rejects.toMatchObject({ code: "ATTACHMENT_TOTAL_SIZE_EXCEEDED" });
    expect(api.beginAttachmentUpload).not.toHaveBeenCalled();
  });

  it("slices 8 MiB chunks, skips received indexes, and completes with whole-file SHA-256", async () => {
    const { api, cache, chunks, controller, store } = fixture({
      receivedChunkIndexes: [0]
    });
    const bytes = new Uint8Array(CHUNK_BYTES + 3);
    bytes.fill(0x61);
    bytes.set([1, 2, 3], CHUNK_BYTES);
    const file = new File([bytes], "report.pdf", { type: "application/pdf" });

    const [ready] = await controller.addFiles({
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      files: [file]
    });

    expect(api.putAttachmentChunk).toHaveBeenCalledOnce();
    expect(chunks[0]?.chunkIndex).toBe(1);
    expect(chunks[0]?.blob.size).toBe(3);
    expect(chunks[0]?.sha256).toBe(sha256(bytes.subarray(CHUNK_BYTES)));
    expect(api.completeAttachmentUpload).toHaveBeenCalledWith(
      "attachment:upload-001",
      {
        sha256: sha256(bytes),
        chunkCount: 2
      },
      expect.anything()
    );
    expect(ready).toMatchObject({
      agentRef: "agent:a",
      threadRef: "thread:chat-a",
      progress: 1,
      receivedChunkIndexes: [0, 1],
      serverState: "ready",
      publicMetadata: {
        attachmentRef: "attachment:upload-001"
      }
    });
    expect((await readAttachmentDrafts(cache, {
      agentRef: "agent:a",
      threadRef: "thread:chat-a"
    }))[0]).toMatchObject({ serverState: "ready" });
    expect(store.getState().attachmentDrafts).toHaveLength(1);
  }, 20_000);

  it("resumes a cached upload without creating a new server upload", async () => {
    const { api, cache, controller } = fixture();
    const file = new File(["abcdefgh"], "report.pdf", {
      type: "application/pdf"
    });
    await saveAttachmentDraft(cache, {
      attachmentRef: "attachment:resume-001",
      agentRef: "agent:a",
      threadRef: "thread:work-a",
      fileName: file.name,
      mediaType: file.type,
      sizeBytes: file.size,
      fileBlob: file,
      chunkBytes: 4,
      chunkCount: 2,
      receivedChunkIndexes: [0],
      progress: 0.5,
      serverState: "uploading",
      publicMetadata: null,
      error: null
    });

    const ready = await controller.resumeAttachment(
      "attachment:resume-001"
    );

    expect(api.beginAttachmentUpload).not.toHaveBeenCalled();
    expect(api.putAttachmentChunk).toHaveBeenCalledOnce();
    expect(api.putAttachmentChunk.mock.calls[0]?.[1]).toBe(1);
    expect(ready.serverState).toBe("ready");
  });

  it("restores only the selected Agent and Thread tray and cancels server state", async () => {
    const { api, cache, controller, store } = fixture();
    for (const draft of [
      {
        attachmentRef: "attachment:chat-a",
        agentRef: "agent:a",
        threadRef: "thread:chat-a"
      },
      {
        attachmentRef: "attachment:work-a",
        agentRef: "agent:a",
        threadRef: "thread:work-a"
      },
      {
        attachmentRef: "attachment:chat-b",
        agentRef: "agent:b",
        threadRef: "thread:chat-b"
      }
    ]) {
      await saveAttachmentDraft(cache, {
        ...draft,
        fileName: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1,
        serverState: "ready"
      });
    }

    await controller.restore("agent:a", "thread:chat-a");
    expect(store.getState().attachmentDrafts.map((draft) =>
      draft.attachmentRef
    )).toEqual(["attachment:chat-a"]);
    await controller.restore("agent:a", "thread:work-a");
    expect(store.getState().attachmentDrafts.map((draft) =>
      draft.attachmentRef
    )).toEqual(["attachment:work-a"]);
    await controller.restore("agent:b", "thread:chat-b");
    expect(store.getState().attachmentDrafts.map((draft) =>
      draft.attachmentRef
    )).toEqual(["attachment:chat-b"]);

    await controller.cancelAttachment("attachment:chat-b");
    expect(api.cancelAttachmentUpload).toHaveBeenCalledWith(
      "attachment:chat-b",
      expect.anything()
    );
    expect(await readAttachmentDrafts(cache, {
      agentRef: "agent:b",
      threadRef: "thread:chat-b"
    })).toEqual([]);
    expect(store.getState().attachmentDrafts).toEqual([]);
  });
});
