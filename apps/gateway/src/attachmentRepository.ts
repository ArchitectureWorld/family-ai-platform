import { randomUUID } from "node:crypto";
import {
  type AttachmentPublicMetadata,
  DEFAULT_FAMILY_ATTACHMENT_QUOTA_BYTES,
  INCOMPLETE_UPLOAD_TTL_MS,
  MAX_FILE_BYTES
} from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";
import { normalizeAttachmentName } from "./attachmentPolicy.js";
import { GatewayDomainError } from "./service.js";

export type AttachmentState =
  | "uploading"
  | "ready"
  | "attached"
  | "expired"
  | "deleted";

export interface AttachmentRecord {
  attachmentRef: string;
  familyRef: string;
  ownerPersonRef: string;
  fileName: string;
  declaredMediaType: string;
  detectedMediaType: string | null;
  sizeBytes: number;
  reservedBytes: number;
  sha256: string | null;
  storageKey: string | null;
  state: AttachmentState;
  createdAt: string;
  expiresAt: string | null;
  completedAt: string | null;
  attachedAt: string | null;
}

export interface ExpiredAttachment {
  attachmentRef: string;
  storageKeys: string[];
}

export interface AttachmentDownloadRecord {
  attachment: AttachmentRecord;
  metadata: AttachmentPublicMetadata;
}

function domainError(
  code: string,
  statusCode: number,
  category: "validation" | "permission" | "availability" | "timeout" | "conflict" | "internal",
  message: string
): GatewayDomainError {
  return new GatewayDomainError(
    code,
    statusCode,
    category,
    false,
    message
  );
}

function mapAttachment(row: Record<string, unknown>): AttachmentRecord {
  return {
    attachmentRef: String(row.attachment_ref),
    familyRef: String(row.family_ref),
    ownerPersonRef: String(row.owner_person_ref),
    fileName: String(row.file_name),
    declaredMediaType: String(row.declared_media_type),
    detectedMediaType:
      row.detected_media_type === null ? null : String(row.detected_media_type),
    sizeBytes: Number(row.size_bytes),
    reservedBytes: Number(row.reserved_bytes),
    sha256: row.sha256 === null ? null : String(row.sha256),
    storageKey: row.storage_key === null ? null : String(row.storage_key),
    state: row.state as AttachmentState,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    attachedAt: row.attached_at === null ? null : String(row.attached_at)
  };
}

export class AttachmentRepository {
  private readonly quotaBytes: number;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly db: GatewayDatabase,
    options: {
      quotaBytes?: number;
      now?: () => Date;
      uuid?: () => string;
    } = {}
  ) {
    this.quotaBytes =
      options.quotaBytes ?? DEFAULT_FAMILY_ATTACHMENT_QUOTA_BYTES;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  familyReservedBytes(familyRef: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes
       FROM attachments WHERE family_ref = ?`
    ).get(familyRef) as { reserved_bytes: number };
    return Number(row.reserved_bytes);
  }

  reserveUpload(input: {
    familyRef: string;
    personRef: string;
    fileName: string;
    declaredMediaType: string;
    sizeBytes: number;
  }): AttachmentRecord {
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > MAX_FILE_BYTES
    ) {
      throw domainError(
        "ATTACHMENT_SIZE_INVALID",
        400,
        "validation",
        "附件大小不正确。"
      );
    }
    const fileName = normalizeAttachmentName(input.fileName);
    const reserve = this.db.transaction(() => {
      const membership = this.db.prepare(
        `SELECT 1 FROM family_memberships
         WHERE family_ref = ? AND person_ref = ? AND status = 'active'`
      ).get(input.familyRef, input.personRef);
      if (!membership) {
        throw domainError(
          "ATTACHMENT_NOT_FOUND",
          404,
          "permission",
          "没有找到这个附件。"
        );
      }
      if (
        this.familyReservedBytes(input.familyRef) + input.sizeBytes >
        this.quotaBytes
      ) {
        throw domainError(
          "ATTACHMENT_QUOTA_EXCEEDED",
          409,
          "conflict",
          "家庭附件空间不足。"
        );
      }
      const now = this.now();
      const createdAt = now.toISOString();
      const expiresAt = new Date(
        now.getTime() + INCOMPLETE_UPLOAD_TTL_MS
      ).toISOString();
      const attachmentRef = `attachment:${this.uuid()}`;
      this.db.prepare(
        `INSERT INTO attachments
         (attachment_ref, family_ref, owner_person_ref, file_name,
          declared_media_type, detected_media_type, size_bytes, reserved_bytes,
          sha256, storage_key, state, created_at, expires_at, completed_at,
          attached_at)
         VALUES(?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 'uploading', ?, ?,
                NULL, NULL)`
      ).run(
        attachmentRef,
        input.familyRef,
        input.personRef,
        fileName,
        input.declaredMediaType,
        input.sizeBytes,
        input.sizeBytes,
        createdAt,
        expiresAt
      );
      return this.getOwned(
        input.familyRef,
        input.personRef,
        attachmentRef
      )!;
    });
    return reserve.immediate();
  }

  private getOwned(
    familyRef: string,
    personRef: string,
    attachmentRef: string
  ): AttachmentRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM attachments
       WHERE attachment_ref = ? AND family_ref = ? AND owner_person_ref = ?`
    ).get(attachmentRef, familyRef, personRef) as
      | Record<string, unknown>
      | undefined;
    return row ? mapAttachment(row) : null;
  }

  private requireOwned(
    familyRef: string,
    personRef: string,
    attachmentRef: string
  ): AttachmentRecord {
    const attachment = this.getOwned(familyRef, personRef, attachmentRef);
    if (!attachment) {
      throw domainError(
        "ATTACHMENT_NOT_FOUND",
        404,
        "permission",
        "没有找到这个附件。"
      );
    }
    return attachment;
  }

  requireUploading(input: {
    familyRef: string;
    personRef: string;
    attachmentRef: string;
  }): AttachmentRecord {
    const attachment = this.requireOwned(
      input.familyRef,
      input.personRef,
      input.attachmentRef
    );
    if (
      attachment.state !== "uploading" ||
      !attachment.expiresAt ||
      Date.parse(attachment.expiresAt) <= this.now().getTime()
    ) {
      throw domainError(
        "ATTACHMENT_UPLOAD_EXPIRED",
        409,
        "conflict",
        "附件上传已经过期。"
      );
    }
    return attachment;
  }

  recordChunk(input: {
    familyRef: string;
    personRef: string;
    attachmentRef: string;
    chunkIndex: number;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  }): "created" | "replayed" {
    const record = this.db.transaction(() => {
      this.requireUploading(input);
      const existing = this.db.prepare(
        `SELECT size_bytes, sha256, storage_key FROM attachment_chunks
         WHERE attachment_ref = ? AND chunk_index = ?`
      ).get(input.attachmentRef, input.chunkIndex) as
        | { size_bytes: number; sha256: string; storage_key: string }
        | undefined;
      if (existing) {
        if (
          Number(existing.size_bytes) === input.sizeBytes &&
          existing.sha256 === input.sha256 &&
          existing.storage_key === input.storageKey
        ) {
          return "replayed" as const;
        }
        throw domainError(
          "ATTACHMENT_CHUNK_CONFLICT",
          409,
          "conflict",
          "同一个分片编号已经写入不同内容。"
        );
      }
      this.db.prepare(
        `INSERT INTO attachment_chunks
         (attachment_ref, chunk_index, size_bytes, sha256, storage_key,
          created_at)
         VALUES(?, ?, ?, ?, ?, ?)`
      ).run(
        input.attachmentRef,
        input.chunkIndex,
        input.sizeBytes,
        input.sha256,
        input.storageKey,
        this.now().toISOString()
      );
      return "created" as const;
    });
    return record.immediate();
  }

  listChunks(input: {
    familyRef: string;
    personRef: string;
    attachmentRef: string;
  }): Array<{
    chunkIndex: number;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  }> {
    this.requireOwned(input.familyRef, input.personRef, input.attachmentRef);
    return this.db.prepare(
      `SELECT chunk_index, size_bytes, sha256, storage_key
       FROM attachment_chunks WHERE attachment_ref = ? ORDER BY chunk_index`
    ).all(input.attachmentRef).map((row) => {
      const value = row as Record<string, unknown>;
      return {
        chunkIndex: Number(value.chunk_index),
        sizeBytes: Number(value.size_bytes),
        sha256: String(value.sha256),
        storageKey: String(value.storage_key)
      };
    });
  }

  completeUpload(input: {
    familyRef: string;
    personRef: string;
    attachmentRef: string;
    detectedMediaType: string;
    sha256: string;
    storageKey: string;
  }): AttachmentRecord {
    const complete = this.db.transaction(() => {
      this.requireUploading(input);
      const completedAt = this.now().toISOString();
      this.db.prepare(
        `UPDATE attachments
         SET detected_media_type = ?, sha256 = ?, storage_key = ?,
             state = 'ready', expires_at = NULL, completed_at = ?
         WHERE attachment_ref = ?`
      ).run(
        input.detectedMediaType,
        input.sha256,
        input.storageKey,
        completedAt,
        input.attachmentRef
      );
      return this.requireOwned(
        input.familyRef,
        input.personRef,
        input.attachmentRef
      );
    });
    return complete.immediate();
  }

  requireReady(input: {
    familyRef: string;
    personRef: string;
    attachmentRef: string;
  }): AttachmentRecord {
    const attachment = this.requireOwned(
      input.familyRef,
      input.personRef,
      input.attachmentRef
    );
    if (
      attachment.state !== "ready" ||
      !attachment.sha256 ||
      !attachment.storageKey ||
      !attachment.detectedMediaType
    ) {
      throw domainError(
        "ATTACHMENT_NOT_READY",
        409,
        "conflict",
        "附件尚未上传完成。"
      );
    }
    return attachment;
  }

  publicMetadata(attachment: AttachmentRecord): AttachmentPublicMetadata {
    if (
      !attachment.detectedMediaType ||
      !attachment.sha256 ||
      !attachment.storageKey
    ) {
      throw domainError(
        "ATTACHMENT_NOT_READY",
        409,
        "conflict",
        "附件尚未上传完成。"
      );
    }
    return {
      attachmentRef: attachment.attachmentRef,
      fileName: attachment.fileName,
      mediaType: attachment.detectedMediaType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      downloadUrl:
        `/api/v1/attachments/${encodeURIComponent(attachment.attachmentRef)}`
    };
  }

  requireDownload(input: {
    familyRef: string;
    personRef: string;
    attachmentRef: string;
  }): AttachmentDownloadRecord {
    const attachment = this.requireOwned(
      input.familyRef,
      input.personRef,
      input.attachmentRef
    );
    if (
      attachment.state !== "ready" &&
      attachment.state !== "attached"
    ) {
      throw domainError(
        "ATTACHMENT_NOT_FOUND",
        404,
        "permission",
        "没有找到这个附件。"
      );
    }
    return {
      attachment,
      metadata: this.publicMetadata(attachment)
    };
  }

  private storageKeys(attachmentRef: string): string[] {
    const attachment = this.db.prepare(
      "SELECT storage_key FROM attachments WHERE attachment_ref = ?"
    ).get(attachmentRef) as { storage_key: string | null } | undefined;
    const chunks = this.db.prepare(
      `SELECT storage_key FROM attachment_chunks
       WHERE attachment_ref = ? ORDER BY chunk_index`
    ).all(attachmentRef) as Array<{ storage_key: string }>;
    return [
      ...chunks.map((row) => row.storage_key),
      ...(attachment?.storage_key ? [attachment.storage_key] : [])
    ];
  }

  cancelUpload(input: {
    familyRef: string;
    personRef: string;
    attachmentRef: string;
  }): string[] {
    const cancel = this.db.transaction(() => {
      const attachment = this.requireOwned(
        input.familyRef,
        input.personRef,
        input.attachmentRef
      );
      if (attachment.state === "attached") {
        throw domainError(
          "ATTACHMENT_ALREADY_ATTACHED",
          409,
          "conflict",
          "已经随消息发送的附件不能取消。"
        );
      }
      const storageKeys = this.storageKeys(input.attachmentRef);
      this.db.prepare(
        `UPDATE attachments
         SET state = 'deleted', reserved_bytes = 0, expires_at = NULL
         WHERE attachment_ref = ?`
      ).run(input.attachmentRef);
      this.db.prepare(
        "DELETE FROM attachment_chunks WHERE attachment_ref = ?"
      ).run(input.attachmentRef);
      return storageKeys;
    });
    return cancel.immediate();
  }

  expireIncompleteUploads(): ExpiredAttachment[] {
    const expire = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT attachment_ref FROM attachments
         WHERE state = 'uploading' AND expires_at <= ?
         ORDER BY attachment_ref`
      ).all(this.now().toISOString()) as Array<{ attachment_ref: string }>;
      const expired = rows.map((row) => ({
        attachmentRef: row.attachment_ref,
        storageKeys: this.storageKeys(row.attachment_ref)
      }));
      for (const item of expired) {
        this.db.prepare(
          `UPDATE attachments
           SET state = 'expired', reserved_bytes = 0
           WHERE attachment_ref = ?`
        ).run(item.attachmentRef);
        this.db.prepare(
          "DELETE FROM attachment_chunks WHERE attachment_ref = ?"
        ).run(item.attachmentRef);
      }
      return expired;
    });
    return expire.immediate();
  }
}
