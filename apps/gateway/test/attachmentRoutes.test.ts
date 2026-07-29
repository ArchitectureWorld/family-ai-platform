import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderInvocationRequest,
  ProviderInvocationResult
} from "@family-ai/contracts";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "attachment-routes-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
}

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

class MissingSessionOnceProvider extends FakeProviderAdapter {
  override async invoke(
    request: ProviderInvocationRequest
  ): Promise<ProviderInvocationResult> {
    if (this.calls.length === 1) {
      this.calls.push(structuredClone(request));
      const failed: ProviderInvocationResult = {
        protocolVersion: "1.0",
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "failed",
        completedAt: "2026-07-29T08:01:31.000Z",
        error: {
          code: "PROVIDER_SESSION_NOT_FOUND",
          category: "conflict",
          message: "原个人助理会话已失效，请重新开始会话。",
          retryable: false
        }
      };
      this.results.push(failed);
      return failed;
    }
    return super.invoke(request);
  }
}

describe("attachment upload and download routes", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let provider: MissingSessionOnceProvider;
  let personal: EntryCredential;
  let admin: EntryCredential;
  let currentNow: Date;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    currentNow = new Date("2026-07-29T08:00:00.000Z");
    provider = new MissingSessionOnceProvider({ clock: () => currentNow });
    app = await buildGatewayApp({
      databasePath,
      attachmentRoot: join(directory, "attachments"),
      attachmentQuotaBytes: 20000,
      deviceToken,
      providerAdapter: provider,
      mode: "test",
      now: () => currentNow
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "附件测试家庭",
        ownerName: "附件测试成员",
        deviceName: "附件测试设备"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const body = onboarding.json() as {
      entries: {
        personal: EntryCredential;
        admin: EntryCredential;
      };
    };
    personal = body.entries.personal;
    admin = body.entries.admin;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function beginUpload(input: {
    fileName?: string;
    mediaType?: string;
    sizeBytes: number;
  }) {
    return app.inject({
      method: "POST",
      url: "/api/v1/attachments/uploads",
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        fileName: input.fileName ?? "report.pdf",
        mediaType: input.mediaType ?? "application/pdf",
        sizeBytes: input.sizeBytes
      }
    });
  }

  async function completeUpload(input: {
    bytes: Buffer;
    fileName?: string;
    mediaType?: string;
  }): Promise<string> {
    const begun = await beginUpload({
      fileName: input.fileName,
      mediaType: input.mediaType,
      sizeBytes: input.bytes.length
    });
    expect(begun.statusCode).toBe(201);
    const attachmentRef = String(begun.json().attachmentRef);
    const chunk = await app.inject({
      method: "PUT",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(attachmentRef)}/chunks/0`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1",
        "content-type": "application/octet-stream",
        "x-family-ai-chunk-sha256": sha256(input.bytes),
        "content-length": String(input.bytes.length)
      },
      payload: input.bytes
    });
    expect(chunk.statusCode).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(attachmentRef)}/complete`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        sha256: sha256(input.bytes),
        chunkCount: 1
      }
    });
    expect(completed.statusCode).toBe(200);
    return attachmentRef;
  }

  it("accepts identical content twice and preserves the shared blob when one upload is cancelled", async () => {
    const bytes = Buffer.from("%PDF-1.7\nshared attachment bytes\n", "utf8");
    const firstRef = await completeUpload({ bytes, fileName: "first.pdf" });
    const secondRef = await completeUpload({ bytes, fileName: "second.pdf" });
    expect(secondRef).not.toBe(firstRef);

    const cancelled = await app.inject({
      method: "DELETE",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(secondRef)}`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      }
    });
    expect(cancelled.statusCode).toBe(204);

    const firstDownload = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${encodeURIComponent(firstRef)}`,
      headers: entryHeaders(personal)
    });
    expect(firstDownload.statusCode).toBe(200);
    expect(firstDownload.rawPayload).toEqual(bytes);
  });

  it("streams, replays, completes, and downloads an owner attachment", async () => {
    const bytes = Buffer.from("%PDF-1.7\nattachment route fixture\n", "utf8");
    const begun = await beginUpload({ sizeBytes: bytes.length });
    expect(begun.statusCode).toBe(201);
    expect(begun.json()).toMatchObject({
      protocolVersion: 1,
      chunkBytes: 8388608,
      chunkCount: 1,
      receivedChunkIndexes: []
    });
    const attachmentRef = String(begun.json().attachmentRef);
    const chunkUrl =
      `/api/v1/attachments/uploads/${encodeURIComponent(attachmentRef)}/chunks/0`;
    const chunkHeaders = {
      ...entryHeaders(personal),
      "x-family-ai-web-request": "1",
      "content-type": "application/octet-stream",
      "x-family-ai-chunk-sha256": sha256(bytes),
      "content-length": String(bytes.length)
    };
    const chunk = await app.inject({
      method: "PUT",
      url: chunkUrl,
      headers: chunkHeaders,
      payload: bytes
    });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.json()).toMatchObject({
      attachmentRef,
      chunkIndex: 0,
      receivedBytes: bytes.length,
      replayed: false
    });
    const replay = await app.inject({
      method: "PUT",
      url: chunkUrl,
      headers: chunkHeaders,
      payload: bytes
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });

    const completed = await app.inject({
      method: "POST",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(attachmentRef)}/complete`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        sha256: sha256(bytes),
        chunkCount: 1
      }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      protocolVersion: 1,
      attachment: {
        attachmentRef,
        fileName: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: bytes.length,
        sha256: sha256(bytes)
      }
    });

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${encodeURIComponent(attachmentRef)}`,
      headers: {
        ...entryHeaders(personal),
        range: "bytes=0-3"
      }
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(bytes);
    expect(downloaded.headers["content-type"]).toContain("application/pdf");
    expect(downloaded.headers["content-disposition"]).toContain("report.pdf");
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("enforces personal-entry authentication, size, type, expiry, and cancellation", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/attachments/uploads",
      headers: {
        ...entryHeaders(admin),
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        fileName: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: 10
      }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      code: "ENTRY_AUDIENCE_FORBIDDEN",
      category: "permission"
    });

    const oversize = await beginUpload({ sizeBytes: 209715201 });
    expect(oversize.statusCode).toBe(400);

    const archiveBytes = Buffer.from("504b0304", "hex");
    const archive = await beginUpload({
      fileName: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: archiveBytes.length
    });
    expect(archive.statusCode).toBe(201);
    const archiveRef = String(archive.json().attachmentRef);
    await app.inject({
      method: "PUT",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(archiveRef)}/chunks/0`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1",
        "content-type": "application/octet-stream",
        "x-family-ai-chunk-sha256": sha256(archiveBytes),
        "content-length": String(archiveBytes.length)
      },
      payload: archiveBytes
    });
    const rejectedType = await app.inject({
      method: "POST",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(archiveRef)}/complete`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        sha256: sha256(archiveBytes),
        chunkCount: 1
      }
    });
    expect(rejectedType.statusCode).toBe(400);
    expect(rejectedType.json()).toMatchObject({
      code: "ATTACHMENT_TYPE_FORBIDDEN"
    });

    const expiring = await beginUpload({ sizeBytes: 10 });
    const expiringRef = String(expiring.json().attachmentRef);
    currentNow = new Date("2026-07-30T08:00:00.001Z");
    const expiredChunk = await app.inject({
      method: "PUT",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(expiringRef)}/chunks/0`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1",
        "content-type": "application/octet-stream",
        "x-family-ai-chunk-sha256": "a".repeat(64),
        "content-length": "10"
      },
      payload: Buffer.alloc(10)
    });
    expect(expiredChunk.statusCode).toBe(409);
    expect(expiredChunk.json()).toMatchObject({
      code: "ATTACHMENT_UPLOAD_EXPIRED"
    });

    currentNow = new Date("2026-07-29T08:00:00.000Z");
    const cancellable = await beginUpload({ sizeBytes: 10 });
    const cancellableRef = String(cancellable.json().attachmentRef);
    const cancelled = await app.inject({
      method: "DELETE",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(cancellableRef)}`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      }
    });
    expect(cancelled.statusCode).toBe(204);
  });

  it("validates the entire UTF-8 text file instead of only its prefix", async () => {
    const bytes = Buffer.alloc(9000, 0x61);
    bytes[8500] = 0;
    const begun = await beginUpload({
      fileName: "notes.txt",
      mediaType: "text/plain",
      sizeBytes: bytes.length
    });
    expect(begun.statusCode).toBe(201);
    const attachmentRef = String(begun.json().attachmentRef);
    const chunk = await app.inject({
      method: "PUT",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(attachmentRef)}/chunks/0`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1",
        "content-type": "application/octet-stream",
        "x-family-ai-chunk-sha256": sha256(bytes),
        "content-length": String(bytes.length)
      },
      payload: bytes
    });
    expect(chunk.statusCode).toBe(200);

    const completed = await app.inject({
      method: "POST",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(attachmentRef)}/complete`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        sha256: sha256(bytes),
        chunkCount: 1
      }
    });
    expect(completed.statusCode).toBe(400);
    expect(completed.json()).toMatchObject({
      code: "ATTACHMENT_TEXT_INVALID"
    });
    expect(existsSync(join(
      directory,
      "attachments",
      "files",
      sha256(bytes).slice(0, 2),
      `${sha256(bytes)}.blob`
    ))).toBe(false);
  });

  it("atomically attaches ready uploads to an attachment-only Thread message", async () => {
    const chatResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(chatResponse.statusCode).toBe(200);
    const threadRef = String(chatResponse.json().chat.threadRef);
    const bytes = Buffer.from("%PDF-1.7\nmessage attachment\n", "utf8");
    const attachmentRef = await completeUpload({ bytes });
    const payload = {
      protocolVersion: 1,
      clientMessageId: "attachment-message-0001",
      occurredAt: "2026-07-29T08:01:00.000Z",
      content: { type: "text", text: "" },
      attachmentRefs: [attachmentRef]
    };

    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      protocolVersion: 1,
      message: {
        threadRef,
        content: { type: "text", text: "" },
        attachments: [
          {
            attachmentRef,
            fileName: "report.pdf",
            mediaType: "application/pdf",
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
            downloadUrl:
              `/api/v1/attachments/${encodeURIComponent(attachmentRef)}`
          }
        ]
      }
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.attachments).toEqual([
      {
        attachmentRef,
        fileName: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        localPath: join(
          directory,
          "attachments",
          "files",
          sha256(bytes).slice(0, 2),
          `${sha256(bytes)}.blob`
        )
      }
    ]);

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(sent.json());

    const conflictingRef = await completeUpload({
      bytes: Buffer.from("%PDF-1.7\nconflicting attachment\n", "utf8")
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: {
        ...payload,
        attachmentRefs: [conflictingRef]
      }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "THREAD_MESSAGE_CONFLICT" });
    const cancelledAfterConflict = await app.inject({
      method: "DELETE",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(conflictingRef)}`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      }
    });
    expect(cancelledAfterConflict.statusCode).toBe(204);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal)
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().messages[0].attachments).toEqual(
      sent.json().message.attachments
    );

    const rebuildPayload = {
      protocolVersion: 1,
      clientMessageId: "attachment-history-message-0001",
      occurredAt: "2026-07-29T08:01:30.000Z",
      content: { type: "text", text: "根据刚才的附件继续" },
      attachmentRefs: []
    };
    const missingSession = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: rebuildPayload
    });
    expect(missingSession.statusCode).toBe(502);
    expect(missingSession.json()).toMatchObject({
      code: "PROVIDER_SESSION_NOT_FOUND"
    });
    const rebuilt = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: rebuildPayload
    });
    expect(rebuilt.statusCode).toBe(201);
    expect(provider.calls[2]?.attachments).toEqual([]);
    expect(provider.calls[2]?.content[0]?.text).toContain(
      `[附件:report.pdf | application/pdf | ${bytes.length} bytes]`
    );
    expect(provider.calls[2]?.content[0]?.text).not.toContain(
      join(directory, "attachments")
    );
    expect(provider.calls[2]?.content[0]?.text).not.toContain(sha256(bytes));
    expect(provider.calls[2]?.content[0]?.text).not.toContain(
      `/api/v1/attachments/${encodeURIComponent(attachmentRef)}`
    );

    const reused = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: {
        ...payload,
        clientMessageId: "attachment-message-0002",
        occurredAt: "2026-07-29T08:02:00.000Z"
      }
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: "ATTACHMENT_NOT_READY" });

    const rollbackRef = await completeUpload({
      bytes: Buffer.from("%PDF-1.7\nrollback attachment\n", "utf8")
    });
    const missingThread = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread%3Amissing/messages",
      headers: entryHeaders(personal),
      payload: {
        ...payload,
        clientMessageId: "attachment-message-0003",
        attachmentRefs: [rollbackRef]
      }
    });
    expect(missingThread.statusCode).toBe(404);

    const cancelledAfterRollback = await app.inject({
      method: "DELETE",
      url:
        `/api/v1/attachments/uploads/${encodeURIComponent(rollbackRef)}`,
      headers: {
        ...entryHeaders(personal),
        "x-family-ai-web-request": "1"
      }
    });
    expect(cancelledAfterRollback.statusCode).toBe(204);
  });
});
