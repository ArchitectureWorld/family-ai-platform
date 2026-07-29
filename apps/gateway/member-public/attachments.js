import {
  readAttachmentDrafts,
  removeAttachmentDraft,
  saveAttachmentDraft
} from "./cache.js";

export const MAX_FILE_BYTES = 209715200;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 2147483648;
export const ATTACHMENT_CHUNK_BYTES = 8388608;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];
const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

class IncrementalSha256 {
  constructor() {
    this.state = new Uint32Array(SHA256_INITIAL);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.words = new Uint32Array(64);
  }

  process(block, offset = 0) {
    const words = this.words;
    const view = new DataView(block.buffer, block.byteOffset + offset, 64);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const first =
        rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const second =
        rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (
        words[index - 16] + first + words[index - 7] + second
      ) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sumOne =
        rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporaryOne = (
        h + sumOne + choice + SHA256_CONSTANTS[index] + words[index]
      ) >>> 0;
      const sumZero =
        rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporaryTwo = (sumZero + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporaryOne) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporaryOne + temporaryTwo) >>> 0;
    }
    const values = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      this.state[index] = (this.state[index] + values[index]) >>> 0;
    }
  }

  update(input) {
    const bytes = input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
    this.bytesHashed += bytes.length;
    let offset = 0;
    if (this.bufferLength > 0) {
      const required = 64 - this.bufferLength;
      const copied = Math.min(required, bytes.length);
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.process(this.buffer);
        this.bufferLength = 0;
      }
    }
    while (offset + 64 <= bytes.length) {
      this.process(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.length) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.length - offset;
    }
  }

  digestHex() {
    const bitLength = BigInt(this.bytesHashed) * 8n;
    const paddingLength = this.bufferLength < 56 ? 64 : 128;
    const finalBlock = new Uint8Array(paddingLength);
    finalBlock.set(this.buffer.subarray(0, this.bufferLength));
    finalBlock[this.bufferLength] = 0x80;
    const view = new DataView(finalBlock.buffer);
    view.setUint32(paddingLength - 8, Number(bitLength >> 32n), false);
    view.setUint32(
      paddingLength - 4,
      Number(bitLength & 0xffffffffn),
      false
    );
    for (let offset = 0; offset < paddingLength; offset += 64) {
      this.process(finalBlock, offset);
    }
    return [...this.state]
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("");
  }
}

function attachmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mediaTypeFor(file) {
  if (typeof file.type === "string" && file.type.trim()) {
    return file.type.trim().toLowerCase();
  }
  const extension = String(file.name).toLowerCase().split(".").pop();
  const known = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    doc: "application/msword",
    xls: "application/vnd.ms-excel",
    ppt: "application/vnd.ms-powerpoint",
    docx:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    json: "application/json",
    xml: "application/xml"
  };
  return known[extension] ?? "text/plain";
}

function validateFiles(existing, files) {
  if (
    existing.length + files.length > MAX_ATTACHMENTS_PER_MESSAGE
  ) {
    throw attachmentError(
      "ATTACHMENT_COUNT_EXCEEDED",
      "每条消息最多添加 10 个附件。"
    );
  }
  for (const file of files) {
    if (
      !Number.isSafeInteger(file?.size) ||
      file.size < 1 ||
      file.size > MAX_FILE_BYTES
    ) {
      throw attachmentError(
        "ATTACHMENT_SIZE_INVALID",
        "单个附件不能超过 200MB。"
      );
    }
  }
  const total = [...existing, ...files].reduce(
    (sum, value) => sum + Number(value.sizeBytes ?? value.size),
    0
  );
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw attachmentError(
      "ATTACHMENT_TOTAL_SIZE_EXCEEDED",
      "单条消息的附件总大小超过限制。"
    );
  }
}

function hexDigest(value) {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createAttachmentController(input) {
  const { api, cache, store } = input;
  const cryptoImpl = input.cryptoImpl ?? globalThis.crypto;
  const now = input.now ?? (() => new Date());
  if (!cryptoImpl?.subtle) throw new Error("WEB_CRYPTO_UNAVAILABLE");
  const activeUploads = new Map();

  async function project(agentRef, threadRef) {
    const attachmentDrafts = await readAttachmentDrafts(cache, {
      agentRef,
      threadRef
    });
    store.setState((current) => ({ ...current, attachmentDrafts }));
    return attachmentDrafts;
  }

  async function persist(draft) {
    const saved = { ...draft, updatedAt: now().toISOString() };
    await saveAttachmentDraft(cache, saved);
    await project(saved.agentRef, saved.threadRef);
    return saved;
  }

  async function transmit(sourceDraft) {
    const controller = new AbortController();
    activeUploads.set(sourceDraft.attachmentRef, controller);
    let draft = {
      ...sourceDraft,
      serverState: "uploading",
      error: null
    };
    try {
      const received = new Set(draft.receivedChunkIndexes ?? []);
      const wholeHash = new IncrementalSha256();
      for (let chunkIndex = 0; chunkIndex < draft.chunkCount; chunkIndex += 1) {
        const start = chunkIndex * draft.chunkBytes;
        const end = Math.min(start + draft.chunkBytes, draft.sizeBytes);
        const blob = draft.fileBlob.slice(start, end, draft.mediaType);
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        wholeHash.update(bytes);
        if (!received.has(chunkIndex)) {
          const digest = hexDigest(
            await cryptoImpl.subtle.digest("SHA-256", buffer)
          );
          await api.putAttachmentChunk(
            draft.attachmentRef,
            chunkIndex,
            blob,
            digest,
            { signal: controller.signal }
          );
          received.add(chunkIndex);
        }
        draft = await persist({
          ...draft,
          receivedChunkIndexes: [...received].sort((left, right) => left - right),
          progress: (chunkIndex + 1) / draft.chunkCount
        });
      }
      const completed = await api.completeAttachmentUpload(
        draft.attachmentRef,
        {
          sha256: wholeHash.digestHex(),
          chunkCount: draft.chunkCount
        },
        { signal: controller.signal }
      );
      draft = await persist({
        ...draft,
        fileBlob: null,
        progress: 1,
        serverState: "ready",
        publicMetadata: completed.attachment,
        error: null
      });
      return draft;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      await persist({
        ...draft,
        serverState: "error",
        error: {
          code: error?.code ?? "ATTACHMENT_UPLOAD_FAILED",
          message: error?.message ?? "附件上传失败。",
          retryable: error?.retryable !== false
        }
      });
      throw error;
    } finally {
      if (activeUploads.get(sourceDraft.attachmentRef) === controller) {
        activeUploads.delete(sourceDraft.attachmentRef);
      }
    }
  }

  async function addFiles({ agentRef, threadRef, files }) {
    const values = [...files];
    const existing = await readAttachmentDrafts(cache, {
      agentRef,
      threadRef
    });
    validateFiles(existing, values);
    const results = [];
    for (const file of values) {
      const metadata = {
        fileName: String(file.name),
        mediaType: mediaTypeFor(file),
        sizeBytes: file.size
      };
      const begun = await api.beginAttachmentUpload(metadata);
      const createdAt = now().toISOString();
      const draft = await persist({
        attachmentRef: begun.attachmentRef,
        agentRef,
        threadRef,
        ...metadata,
        fileBlob: file.slice(0, file.size, metadata.mediaType),
        chunkBytes: begun.chunkBytes,
        chunkCount: begun.chunkCount,
        receivedChunkIndexes: [...begun.receivedChunkIndexes],
        progress: begun.receivedChunkIndexes.length / begun.chunkCount,
        serverState: "uploading",
        publicMetadata: null,
        error: null,
        createdAt,
        updatedAt: createdAt
      });
      results.push(await transmit(draft));
    }
    return results;
  }

  async function resumeAttachment(attachmentRef) {
    const drafts = await readAttachmentDrafts(cache);
    const draft = drafts.find(
      (candidate) => candidate.attachmentRef === attachmentRef
    );
    if (!draft) {
      throw attachmentError("ATTACHMENT_DRAFT_NOT_FOUND", "没有找到这个附件。");
    }
    if (draft.serverState === "ready") return draft;
    if (!draft.fileBlob) {
      throw attachmentError(
        "ATTACHMENT_FILE_MISSING",
        "需要重新选择这个附件。"
      );
    }
    return transmit(draft);
  }

  async function cancelAttachment(attachmentRef) {
    activeUploads.get(attachmentRef)?.abort();
    const drafts = await readAttachmentDrafts(cache);
    const draft = drafts.find(
      (candidate) => candidate.attachmentRef === attachmentRef
    );
    if (!draft) return;
    await api.cancelAttachmentUpload(attachmentRef, {});
    await removeAttachmentDraft(cache, attachmentRef);
    await project(draft.agentRef, draft.threadRef);
  }

  return {
    addFiles,
    resumeAttachment,
    cancelAttachment,
    restore: project,
    stop() {
      for (const controller of activeUploads.values()) controller.abort();
      activeUploads.clear();
    }
  };
}
