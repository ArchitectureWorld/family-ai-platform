import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

function storageError(code: string, message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  return new Promise((resolveDigest, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const information = lstatSync(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件存储目录不安全。");
  }
  chmodSync(path, 0o700);
}

function safeAttachmentHash(attachmentRef: string): string {
  return createHash("sha256").update(attachmentRef, "utf8").digest("hex");
}

export interface StoredChunk {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  replayed: boolean;
}

export interface AssembledAttachment {
  storageKey: string;
  localPath: string;
  sizeBytes: number;
  sha256: string;
  prefix: Buffer;
}

export class AttachmentStorage {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) {
      throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件存储目录必须是绝对路径。");
    }
    const requested = resolve(root);
    if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
      throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件存储目录不能是符号链接。");
    }
    ensurePrivateDirectory(requested);
    this.root = realpathSync(requested);
    for (const directory of ["chunks", "files", "tmp"]) {
      ensurePrivateDirectory(resolve(this.root, directory));
    }
  }

  resolveStorageKey(storageKey: string): string {
    if (
      typeof storageKey !== "string" ||
      !/^(?:chunks|files|tmp)\/[a-z0-9][a-z0-9/.-]*$/u.test(storageKey)
    ) {
      throw storageError("ATTACHMENT_STORAGE_KEY_INVALID", "附件存储编号无效。");
    }
    const candidate = resolve(this.root, storageKey);
    const pathRelative = relative(this.root, candidate);
    if (
      pathRelative === "" ||
      pathRelative === ".." ||
      pathRelative.startsWith(`..${sep}`) ||
      isAbsolute(pathRelative)
    ) {
      throw storageError("ATTACHMENT_STORAGE_KEY_INVALID", "附件存储编号越界。");
    }
    return candidate;
  }

  private ensureStorageParent(path: string): void {
    const parent = dirname(path);
    ensurePrivateDirectory(parent);
    const canonicalParent = realpathSync(parent);
    if (!canonicalParent.startsWith(`${this.root}${sep}`)) {
      throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件存储路径越界。");
    }
  }

  private async requireExisting(
    path: string,
    expectedBytes: number,
    expectedSha256: string
  ): Promise<void> {
    const information = lstatSync(path);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size !== expectedBytes ||
      await digestFile(path) !== expectedSha256
    ) {
      throw storageError(
        "ATTACHMENT_CHUNK_CONFLICT",
        "同一个分片编号已经写入不同内容。"
      );
    }
  }

  async writeChunk(input: {
    attachmentRef: string;
    chunkIndex: number;
    stream: Readable;
    expectedBytes: number;
    expectedSha256: string;
  }): Promise<StoredChunk> {
    const attachmentHash = safeAttachmentHash(input.attachmentRef);
    const storageKey = `chunks/${attachmentHash}/${input.chunkIndex}.part`;
    const path = this.resolveStorageKey(storageKey);
    this.ensureStorageParent(path);
    if (existsSync(path)) {
      await this.requireExisting(path, input.expectedBytes, input.expectedSha256);
      return {
        storageKey,
        sizeBytes: input.expectedBytes,
        sha256: input.expectedSha256,
        replayed: true
      };
    }

    const hash = createHash("sha256");
    let sizeBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > input.expectedBytes) {
          callback(storageError(
            "ATTACHMENT_CHUNK_SIZE_INVALID",
            "附件分片大小不正确。"
          ));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    let fileDescriptor: number | null = null;
    try {
      fileDescriptor = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      const output = createWriteStream(path, {
        fd: fileDescriptor,
        autoClose: true
      });
      fileDescriptor = null;
      await pipeline(input.stream, counter, output);
      if (sizeBytes !== input.expectedBytes) {
        throw storageError(
          "ATTACHMENT_CHUNK_SIZE_INVALID",
          "附件分片大小不正确。"
        );
      }
      const digest = hash.digest("hex");
      if (digest !== input.expectedSha256) {
        throw storageError(
          "ATTACHMENT_CHUNK_HASH_MISMATCH",
          "附件分片校验失败。"
        );
      }
      return {
        storageKey,
        sizeBytes,
        sha256: digest,
        replayed: false
      };
    } catch (error) {
      if (fileDescriptor !== null) closeSync(fileDescriptor);
      if (existsSync(path)) unlinkSync(path);
      throw error;
    }
  }

  async assemble(input: {
    attachmentRef: string;
    chunkStorageKeys: string[];
    expectedBytes: number;
    expectedSha256: string;
  }): Promise<AssembledAttachment> {
    const attachmentHash = safeAttachmentHash(input.attachmentRef);
    const temporaryKey = `tmp/${attachmentHash}.assembling`;
    const temporaryPath = this.resolveStorageKey(temporaryKey);
    this.ensureStorageParent(temporaryPath);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    let descriptor: number | null = null;
    let sizeBytes = 0;
    const hash = createHash("sha256");
    const prefixParts: Buffer[] = [];
    let prefixBytes = 0;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      for (const storageKey of input.chunkStorageKeys) {
        const chunkPath = this.resolveStorageKey(storageKey);
        const information = lstatSync(chunkPath);
        if (!information.isFile() || information.isSymbolicLink()) {
          throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件分片不是普通文件。");
        }
        for await (const value of createReadStream(chunkPath)) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          sizeBytes += chunk.length;
          if (sizeBytes > input.expectedBytes) {
            throw storageError("ATTACHMENT_SIZE_INVALID", "附件总大小不正确。");
          }
          hash.update(chunk);
          if (prefixBytes < 8192) {
            const part = chunk.subarray(0, 8192 - prefixBytes);
            prefixParts.push(part);
            prefixBytes += part.length;
          }
          let offset = 0;
          while (offset < chunk.length) {
            offset += writeSync(descriptor, chunk, offset);
          }
        }
      }
      if (sizeBytes !== input.expectedBytes) {
        throw storageError("ATTACHMENT_SIZE_INVALID", "附件总大小不正确。");
      }
      const digest = hash.digest("hex");
      if (digest !== input.expectedSha256) {
        throw storageError("ATTACHMENT_HASH_MISMATCH", "附件整体校验失败。");
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;

      const storageKey = `files/${digest.slice(0, 2)}/${digest}.blob`;
      const finalPath = this.resolveStorageKey(storageKey);
      this.ensureStorageParent(finalPath);
      if (existsSync(finalPath)) {
        await this.requireExisting(finalPath, sizeBytes, digest);
        unlinkSync(temporaryPath);
      } else {
        renameSync(temporaryPath, finalPath);
      }
      return {
        storageKey,
        localPath: realpathSync(finalPath),
        sizeBytes,
        sha256: digest,
        prefix: Buffer.concat(prefixParts)
      };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }

  removeStorageKeys(storageKeys: readonly string[]): void {
    for (const storageKey of storageKeys) {
      const path = this.resolveStorageKey(storageKey);
      if (!existsSync(path)) continue;
      const information = lstatSync(path);
      if (!information.isFile() || information.isSymbolicLink()) {
        throw storageError("ATTACHMENT_STORAGE_UNSAFE", "拒绝删除非普通附件文件。");
      }
      unlinkSync(path);
    }
  }

  requireRegularFile(storageKey: string): string {
    const path = this.resolveStorageKey(storageKey);
    const pathInformation = lstatSync(path);
    if (!pathInformation.isFile() || pathInformation.isSymbolicLink()) {
      throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件文件不安全。");
    }
    const canonicalPath = realpathSync(path);
    const pathRelative = relative(this.root, canonicalPath);
    if (
      pathRelative === "" ||
      pathRelative === ".." ||
      pathRelative.startsWith(`..${sep}`) ||
      isAbsolute(pathRelative)
    ) {
      throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件文件路径越界。");
    }
    const descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw storageError("ATTACHMENT_STORAGE_UNSAFE", "附件文件不安全。");
      }
    } finally {
      closeSync(descriptor);
    }
    return canonicalPath;
  }

  createDownloadStream(storageKey: string) {
    const path = this.requireRegularFile(storageKey);
    return {
      stream: createReadStream(path),
      sizeBytes: lstatSync(path).size
    };
  }

  async validateUtf8Text(storageKey: string): Promise<void> {
    const path = this.requireRegularFile(storageKey);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for await (const value of createReadStream(path)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (chunk.includes(0)) {
          throw storageError(
            "ATTACHMENT_TEXT_INVALID",
            "文本附件包含无效字节。"
          );
        }
        decoder.decode(chunk, { stream: true });
      }
      decoder.decode();
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ATTACHMENT_TEXT_INVALID"
      ) {
        throw error;
      }
      throw storageError(
        "ATTACHMENT_TEXT_INVALID",
        "文本附件不是有效 UTF-8。"
      );
    }
  }
}
