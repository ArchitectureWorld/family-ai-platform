import type { Readable } from "node:stream";
import {
  ATTACHMENT_CHUNK_BYTES,
  CHAT_WORK_PROTOCOL_VERSION,
  attachmentChunkResponseSchema,
  attachmentCompleteRequestSchema,
  attachmentCompleteResponseSchema,
  attachmentRefSchema,
  attachmentUploadCreateRequestSchema,
  attachmentUploadCreateResponseSchema
} from "@family-ai/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AttachmentRepository } from "./attachmentRepository.js";
import { inspectAttachmentPrefix } from "./attachmentPolicy.js";
import type { AttachmentStorage } from "./attachmentStorage.js";
import {
  requireEntryRequest,
  type EntrySessionAuthenticator
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const attachmentParamsSchema = z
  .object({ attachmentRef: attachmentRefSchema })
  .strict();

const chunkParamsSchema = z
  .object({
    attachmentRef: attachmentRefSchema,
    chunkIndex: z.coerce.number().int().min(0).max(24)
  })
  .strict();

function parseRequest<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayDomainError(
      "REQUEST_INVALID",
      400,
      "validation",
      false,
      message
    );
  }
  return parsed.data;
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function attachmentError(error: unknown): never {
  if (error instanceof GatewayDomainError) throw error;
  const code = (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) ? error.code : "ATTACHMENT_STORAGE_FAILED";
  const conflict = code.includes("CONFLICT") ||
    code.includes("EXPIRED") ||
    code.includes("MISMATCH");
  throw new GatewayDomainError(
    code,
    conflict ? 409 : 400,
    conflict ? "conflict" : "validation",
    false,
    error instanceof Error ? error.message : "附件处理失败。"
  );
}

function chunkCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / ATTACHMENT_CHUNK_BYTES);
}

function expectedChunkBytes(sizeBytes: number, chunkIndex: number): number {
  const count = chunkCount(sizeBytes);
  if (chunkIndex < 0 || chunkIndex >= count) {
    throw new GatewayDomainError(
      "ATTACHMENT_CHUNK_INVALID",
      400,
      "validation",
      false,
      "附件分片编号不正确。"
    );
  }
  return chunkIndex === count - 1
    ? sizeBytes - ATTACHMENT_CHUNK_BYTES * (count - 1)
    : ATTACHMENT_CHUNK_BYTES;
}

function disposition(fileName: string): string {
  return `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  input: {
    repository: AttachmentRepository;
    storage: AttachmentStorage;
    entryAuthenticator: EntrySessionAuthenticator;
  }
): void {
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => done(null, payload)
  );

  app.post("/api/v1/attachments/uploads", async (request, reply) => {
    const context = requireEntryRequest(
      request,
      input.entryAuthenticator,
      "personal"
    );
    const command = parseRequest(
      attachmentUploadCreateRequestSchema,
      request.body,
      "附件名称、类型、大小或协议版本不正确。"
    );
    const attachment = input.repository.reserveUpload({
      familyRef: context.family.familyRef,
      personRef: context.person.personRef,
      fileName: command.fileName,
      declaredMediaType: command.mediaType,
      sizeBytes: command.sizeBytes
    });
    return reply.code(201).send(attachmentUploadCreateResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      attachmentRef: attachment.attachmentRef,
      chunkBytes: ATTACHMENT_CHUNK_BYTES,
      chunkCount: chunkCount(attachment.sizeBytes),
      receivedChunkIndexes: [],
      expiresAt: attachment.expiresAt
    }));
  });

  app.put(
    "/api/v1/attachments/uploads/:attachmentRef/chunks/:chunkIndex",
    { bodyLimit: ATTACHMENT_CHUNK_BYTES },
    async (request) => {
      const context = requireEntryRequest(
        request,
        input.entryAuthenticator,
        "personal"
      );
      const params = parseRequest(
        chunkParamsSchema,
        request.params,
        "附件编号或分片编号不正确。"
      );
      const expectedSha256 = header(request, "x-family-ai-chunk-sha256");
      if (!expectedSha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
        throw new GatewayDomainError(
          "ATTACHMENT_CHUNK_HASH_INVALID",
          400,
          "validation",
          false,
          "附件分片校验值不正确。"
        );
      }
      const attachment = input.repository.requireUploading({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        attachmentRef: params.attachmentRef
      });
      const expectedBytes = expectedChunkBytes(
        attachment.sizeBytes,
        params.chunkIndex
      );
      const contentLength = Number(header(request, "content-length"));
      if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
        throw new GatewayDomainError(
          "ATTACHMENT_CHUNK_SIZE_INVALID",
          400,
          "validation",
          false,
          "附件分片大小不正确。"
        );
      }
      const stream = request.body as Readable;
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
        throw new GatewayDomainError(
          "ATTACHMENT_CHUNK_INVALID",
          400,
          "validation",
          false,
          "附件分片内容无效。"
        );
      }

      try {
        const stored = await input.storage.writeChunk({
          attachmentRef: params.attachmentRef,
          chunkIndex: params.chunkIndex,
          stream,
          expectedBytes,
          expectedSha256
        });
        let replayed: boolean;
        try {
          replayed = input.repository.recordChunk({
            familyRef: context.family.familyRef,
            personRef: context.person.personRef,
            attachmentRef: params.attachmentRef,
            chunkIndex: params.chunkIndex,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            storageKey: stored.storageKey
          }) === "replayed";
        } catch (error) {
          if (!stored.replayed) {
            input.storage.removeStorageKeys([stored.storageKey]);
          }
          throw error;
        }
        return attachmentChunkResponseSchema.parse({
          protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
          attachmentRef: params.attachmentRef,
          chunkIndex: params.chunkIndex,
          receivedBytes: stored.sizeBytes,
          sha256: stored.sha256,
          replayed: stored.replayed || replayed
        });
      } catch (error) {
        return attachmentError(error);
      }
    }
  );

  app.post(
    "/api/v1/attachments/uploads/:attachmentRef/complete",
    async (request) => {
      const context = requireEntryRequest(
        request,
        input.entryAuthenticator,
        "personal"
      );
      const params = parseRequest(
        attachmentParamsSchema,
        request.params,
        "附件编号不正确。"
      );
      const command = parseRequest(
        attachmentCompleteRequestSchema,
        request.body,
        "附件校验值、分片数量或协议版本不正确。"
      );
      const attachment = input.repository.requireUploading({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        attachmentRef: params.attachmentRef
      });
      const expectedCount = chunkCount(attachment.sizeBytes);
      const chunks = input.repository.listChunks({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        attachmentRef: params.attachmentRef
      });
      if (
        command.chunkCount !== expectedCount ||
        chunks.length !== expectedCount ||
        chunks.some((chunk, index) =>
          chunk.chunkIndex !== index ||
          chunk.sizeBytes !== expectedChunkBytes(attachment.sizeBytes, index)
        )
      ) {
        throw new GatewayDomainError(
          "ATTACHMENT_INCOMPLETE",
          409,
          "conflict",
          false,
          "附件分片尚未上传完整。"
        );
      }
      let assembledStorageKey: string | null = null;
      try {
        const assembled = await input.storage.assemble({
          attachmentRef: attachment.attachmentRef,
          chunkStorageKeys: chunks.map((chunk) => chunk.storageKey),
          expectedBytes: attachment.sizeBytes,
          expectedSha256: command.sha256
        });
        assembledStorageKey = assembled.storageKey;
        const inspection = inspectAttachmentPrefix({
          fileName: attachment.fileName,
          declaredMediaType: attachment.declaredMediaType,
          prefix: assembled.prefix
        });
        if (inspection.kind === "utf8-text") {
          await input.storage.validateUtf8Text(assembled.storageKey);
        }
        const completed = input.repository.completeUpload({
          familyRef: context.family.familyRef,
          personRef: context.person.personRef,
          attachmentRef: attachment.attachmentRef,
          detectedMediaType: inspection.detectedMediaType,
          sha256: assembled.sha256,
          storageKey: assembled.storageKey
        });
        return attachmentCompleteResponseSchema.parse({
          protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
          attachment: input.repository.publicMetadata(completed)
        });
      } catch (error) {
        if (
          assembledStorageKey &&
          !input.repository.hasLiveStorageReference(assembledStorageKey)
        ) {
          input.storage.removeStorageKeys([assembledStorageKey]);
        }
        return attachmentError(error);
      }
    }
  );

  app.delete(
    "/api/v1/attachments/uploads/:attachmentRef",
    async (request, reply) => {
      const context = requireEntryRequest(
        request,
        input.entryAuthenticator,
        "personal"
      );
      const params = parseRequest(
        attachmentParamsSchema,
        request.params,
        "附件编号不正确。"
      );
      const storageKeys = input.repository.cancelUpload({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        attachmentRef: params.attachmentRef
      });
      input.storage.removeStorageKeys(storageKeys);
      return reply.code(204).send();
    }
  );

  app.get("/api/v1/attachments/:attachmentRef", async (request, reply) => {
    const context = requireEntryRequest(
      request,
      input.entryAuthenticator,
      "personal"
    );
    const params = parseRequest(
      attachmentParamsSchema,
      request.params,
      "附件编号不正确。"
    );
    const record = input.repository.requireDownload({
      familyRef: context.family.familyRef,
      personRef: context.person.personRef,
      attachmentRef: params.attachmentRef
    });
    const download = input.storage.createDownloadStream(
      record.attachment.storageKey!
    );
    return reply
      .header("Cache-Control", "private, no-store")
      .header("Content-Length", download.sizeBytes)
      .header("Content-Disposition", disposition(record.metadata.fileName))
      .header("X-Content-Type-Options", "nosniff")
      .type(record.metadata.mediaType)
      .send(download.stream);
  });
}
