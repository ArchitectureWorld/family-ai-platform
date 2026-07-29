import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../src/attachmentStorage.js";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("attachment streaming storage", () => {
  let directory = "";

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("creates a private root and streams idempotent chunks without following symlinks", async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-storage-"));
    const root = join(directory, "attachments");
    const storage = new AttachmentStorage(root);
    const bytes = Buffer.from("%PDF-1.7\nsmall fixture\n", "utf8");
    const input = {
      attachmentRef: "attachment:storage-test",
      chunkIndex: 0,
      stream: Readable.from(bytes),
      expectedBytes: bytes.length,
      expectedSha256: sha256(bytes)
    };

    const first = await storage.writeChunk(input);
    const replay = await storage.writeChunk({
      ...input,
      stream: Readable.from(bytes)
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.resolveStorageKey(first.storageKey)).isFile()).toBe(true);
    expect(readFileSync(storage.resolveStorageKey(first.storageKey))).toEqual(bytes);

    await expect(storage.writeChunk({
      ...input,
      stream: Readable.from(Buffer.from("different")),
      expectedBytes: 9,
      expectedSha256: sha256(Buffer.from("different"))
    })).rejects.toMatchObject({ code: "ATTACHMENT_CHUNK_CONFLICT" });
  });

  it("removes a partial file when the streamed size or hash is invalid", async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-storage-limit-"));
    const storage = new AttachmentStorage(join(directory, "attachments"));
    const bytes = Buffer.from("123456", "utf8");

    await expect(storage.writeChunk({
      attachmentRef: "attachment:bad-size",
      chunkIndex: 0,
      stream: Readable.from(bytes),
      expectedBytes: 5,
      expectedSha256: sha256(bytes)
    })).rejects.toMatchObject({ code: "ATTACHMENT_CHUNK_SIZE_INVALID" });
    await expect(storage.writeChunk({
      attachmentRef: "attachment:bad-hash",
      chunkIndex: 0,
      stream: Readable.from(bytes),
      expectedBytes: bytes.length,
      expectedSha256: "a".repeat(64)
    })).rejects.toMatchObject({ code: "ATTACHMENT_CHUNK_HASH_MISMATCH" });
  });

  it("assembles chunks in order, verifies the whole file, and returns a canonical key", async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-assembly-"));
    const storage = new AttachmentStorage(join(directory, "attachments"));
    const firstBytes = Buffer.from("%PDF-1.7\n", "utf8");
    const secondBytes = Buffer.from("payload", "utf8");
    const first = await storage.writeChunk({
      attachmentRef: "attachment:assembly",
      chunkIndex: 0,
      stream: Readable.from(firstBytes),
      expectedBytes: firstBytes.length,
      expectedSha256: sha256(firstBytes)
    });
    const second = await storage.writeChunk({
      attachmentRef: "attachment:assembly",
      chunkIndex: 1,
      stream: Readable.from(secondBytes),
      expectedBytes: secondBytes.length,
      expectedSha256: sha256(secondBytes)
    });
    const whole = Buffer.concat([firstBytes, secondBytes]);

    const assembled = await storage.assemble({
      attachmentRef: "attachment:assembly",
      chunkStorageKeys: [first.storageKey, second.storageKey],
      expectedBytes: whole.length,
      expectedSha256: sha256(whole)
    });

    expect(assembled.storageKey).toBe(`files/${sha256(whole).slice(0, 2)}/${sha256(whole)}.blob`);
    expect(assembled.sizeBytes).toBe(whole.length);
    expect(assembled.prefix.subarray(0, 5).toString()).toBe("%PDF-");
    expect(readFileSync(assembled.localPath)).toEqual(whole);
  });

  it("rejects a symlink root and a symlinked storage key", async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-symlink-"));
    const outside = join(directory, "outside");
    const link = join(directory, "attachments");
    chmodSync(directory, 0o700);
    symlinkSync(outside, link);
    expect(() => new AttachmentStorage(link)).toThrow();
  });

  it("refuses Provider handoff through a final or parent symlink", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-handoff-"));
    const storage = new AttachmentStorage(join(directory, "attachments"));
    const outsideDirectory = join(directory, "outside");
    const outsideFile = join(outsideDirectory, "secret.blob");
    mkdirSync(outsideDirectory);
    writeFileSync(outsideFile, "outside", { mode: 0o600 });

    const leafDirectory = storage.resolveStorageKey("files/aa");
    mkdirSync(leafDirectory);
    const leafLink = storage.resolveStorageKey("files/aa/leaf.blob");
    symlinkSync(outsideFile, leafLink);
    expect(() => storage.requireRegularFile("files/aa/leaf.blob"))
      .toThrowError(/不安全/);

    rmSync(leafDirectory, { recursive: true, force: true });
    symlinkSync(outsideDirectory, leafDirectory);
    expect(() => storage.requireRegularFile("files/aa/secret.blob"))
      .toThrowError(/越界/);
  });
});
