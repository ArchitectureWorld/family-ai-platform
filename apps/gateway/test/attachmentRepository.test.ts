import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentRepository } from "../src/attachmentRepository.js";
import {
  openGatewayDatabase,
  type GatewayDatabase
} from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

describe("attachment metadata repository", () => {
  let directory = "";
  let db: GatewayDatabase;
  let familyRef = "";
  let personRef = "";
  let now: Date;
  let repository: AttachmentRepository;
  let nextId = 1;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-repository-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const onboarding = new FamilyDomainRepository(db).initializeFamily({
      familyName: "附件测试家庭",
      ownerName: "附件测试成员",
      deviceName: "附件测试设备",
      deviceCredential: "attachment-test-device-credential"
    });
    familyRef = onboarding.family.familyRef;
    personRef = onboarding.owner.personRef;
    now = new Date("2026-07-29T08:00:00.000Z");
    repository = new AttachmentRepository(db, {
      quotaBytes: 12,
      now: () => now,
      uuid: () => `upload-${nextId++}`
    });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function reserve(sizeBytes: number, fileName = "report.pdf") {
    return repository.reserveUpload({
      familyRef,
      personRef,
      fileName,
      declaredMediaType: "application/pdf",
      sizeBytes
    });
  }

  it("reserves family quota atomically and rejects overbooking", () => {
    const first = reserve(8);
    expect(first).toMatchObject({
      attachmentRef: "attachment:upload-1",
      familyRef,
      ownerPersonRef: personRef,
      state: "uploading",
      sizeBytes: 8,
      reservedBytes: 8
    });
    expect(() => reserve(5, "second.pdf")).toThrowError(
      expect.objectContaining({ code: "ATTACHMENT_QUOTA_EXCEEDED" })
    );
    expect(repository.familyReservedBytes(familyRef)).toBe(8);
  });

  it("records chunk metadata idempotently and rejects conflicting replay", () => {
    const upload = reserve(8);
    expect(repository.recordChunk({
      familyRef,
      personRef,
      attachmentRef: upload.attachmentRef,
      chunkIndex: 0,
      sizeBytes: 8,
      sha256: "a".repeat(64),
      storageKey: "chunks/aa/0.part"
    })).toBe("created");
    expect(repository.recordChunk({
      familyRef,
      personRef,
      attachmentRef: upload.attachmentRef,
      chunkIndex: 0,
      sizeBytes: 8,
      sha256: "a".repeat(64),
      storageKey: "chunks/aa/0.part"
    })).toBe("replayed");
    expect(() => repository.recordChunk({
      familyRef,
      personRef,
      attachmentRef: upload.attachmentRef,
      chunkIndex: 0,
      sizeBytes: 8,
      sha256: "b".repeat(64),
      storageKey: "chunks/bb/0.part"
    })).toThrowError(expect.objectContaining({
      code: "ATTACHMENT_CHUNK_CONFLICT"
    }));
  });

  it("completes, authorizes, cancels, and expires only owner-scoped uploads", () => {
    const completed = reserve(8);
    repository.completeUpload({
      familyRef,
      personRef,
      attachmentRef: completed.attachmentRef,
      detectedMediaType: "application/pdf",
      sha256: "c".repeat(64),
      storageKey: "files/cc/completed.blob"
    });
    expect(repository.requireReady({
      familyRef,
      personRef,
      attachmentRef: completed.attachmentRef
    })).toMatchObject({
      state: "ready",
      sha256: "c".repeat(64),
      storageKey: "files/cc/completed.blob"
    });
    expect(() => repository.requireReady({
      familyRef,
      personRef: "person:someone-else",
      attachmentRef: completed.attachmentRef
    })).toThrowError(expect.objectContaining({ code: "ATTACHMENT_NOT_FOUND" }));

    const cancelled = reserve(4, "cancelled.pdf");
    expect(repository.cancelUpload({
      familyRef,
      personRef,
      attachmentRef: cancelled.attachmentRef
    })).toEqual([]);
    expect(repository.familyReservedBytes(familyRef)).toBe(8);

    now = new Date("2026-07-30T08:00:01.000Z");
    const expired = repository.expireIncompleteUploads();
    expect(expired).toEqual([]);
  });

  it("expires incomplete uploads after 24 hours and releases reservation", () => {
    const upload = reserve(8);
    repository.recordChunk({
      familyRef,
      personRef,
      attachmentRef: upload.attachmentRef,
      chunkIndex: 0,
      sizeBytes: 8,
      sha256: "d".repeat(64),
      storageKey: "chunks/dd/0.part"
    });
    now = new Date("2026-07-30T08:00:00.001Z");

    expect(repository.expireIncompleteUploads()).toEqual([{
      attachmentRef: upload.attachmentRef,
      storageKeys: ["chunks/dd/0.part"]
    }]);
    expect(repository.familyReservedBytes(familyRef)).toBe(0);
  });
});
