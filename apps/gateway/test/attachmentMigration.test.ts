import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import {
  openGatewayDatabase,
  type GatewayDatabase
} from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const openAtVersion = openGatewayDatabase as unknown as (
  databasePath: string,
  options: { migrationLimit: 7 | 8 }
) => GatewayDatabase;

describe("attachment metadata migration", () => {
  let directory = "";
  let db: GatewayDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("upgrades a real V7 message database without data loss", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-attachment-migration-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 7 });
    const onboarding = new FamilyDomainRepository(db).initializeFamily({
      familyName: "V7 家庭",
      ownerName: "V7 成员",
      deviceName: "V7 设备",
      deviceCredential: "v7-device-credential-with-enough-length"
    });
    const chatDomain = new ChatWorkDomainRepository(
      db,
      () => new Date("2026-07-29T08:00:00.000Z")
    );
    const chat = chatDomain.ensureHomeChat({
      personRef: onboarding.owner.personRef,
      agentRef: "agent:personal-assistant",
      timezone: "Asia/Shanghai",
      localDate: "2026-07-29"
    });
    const original = chatDomain.appendThreadMessage({
      personRef: onboarding.owner.personRef,
      agentRef: "agent:personal-assistant",
      threadRef: chat.chat.threadRef,
      clientMessageId: "v7-attachment-migration-message",
      actor: {
        type: "person",
        personRef: onboarding.owner.personRef
      },
      origin: {
        deviceRef: onboarding.device.deviceRef,
        connectionRef: "connection:v7-migration",
        entryAudience: "personal"
      },
      content: {
        type: "text",
        text: "保留这条 V7 消息。",
        language: "zh-CN"
      },
      occurredAt: "2026-07-29T08:00:00.000Z"
    });
    expect(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
    ).toEqual({ version: 7 });
    db.close();
    db = null;

    db = openGatewayDatabase(databasePath);
    expect(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
    ).toEqual({ version: 8 });
    expect(
      db.prepare(
        `SELECT message_ref, thread_sequence, content_text
         FROM thread_messages WHERE message_ref = ?`
      ).get(original.messageRef)
    ).toEqual({
      message_ref: original.messageRef,
      thread_sequence: 1,
      content_text: "保留这条 V7 消息。"
    });

    db.prepare(
      `INSERT INTO thread_messages
       (message_ref, thread_ref, thread_sequence, client_message_id, actor_type,
        actor_person_ref, actor_assignment_ref, actor_agent_ref,
        actor_provider_profile_ref, actor_system_ref, origin_device_ref,
        origin_connection_ref, entry_audience, content_type, content_text,
        content_language, occurred_at, created_at)
       VALUES(?, ?, 2, ?, 'person', ?, NULL, NULL, NULL, NULL, ?, NULL,
              'personal', 'text', '', NULL, ?, ?)`
    ).run(
      "message:v8-empty-text",
      chat.chat.threadRef,
      "v8-empty-text-client-message",
      onboarding.owner.personRef,
      onboarding.device.deviceRef,
      "2026-07-29T08:01:00.000Z",
      "2026-07-29T08:01:00.000Z"
    );

    const attachmentColumns = db.prepare(
      "SELECT name FROM pragma_table_info('attachments') ORDER BY cid"
    ).all() as Array<{ name: string }>;
    expect(attachmentColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "attachment_ref",
        "family_ref",
        "owner_person_ref",
        "size_bytes",
        "reserved_bytes",
        "storage_key",
        "state"
      ])
    );
    expect(
      db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('attachment_chunks','message_attachments')
         ORDER BY name`
      ).all()
    ).toEqual([
      { name: "attachment_chunks" },
      { name: "message_attachments" }
    ]);

    const insertAttachment = db.prepare(
      `INSERT INTO attachments
       (attachment_ref, family_ref, owner_person_ref, file_name,
        declared_media_type, detected_media_type, size_bytes, reserved_bytes,
        sha256, storage_key, state, created_at, expires_at, completed_at,
        attached_at)
       VALUES(?, ?, ?, ?, 'application/pdf', 'application/pdf', 1, 1, ?, ?,
              'ready', ?, NULL, ?, NULL)`
    );
    insertAttachment.run(
      "attachment:v8-first",
      onboarding.family.familyRef,
      onboarding.owner.personRef,
      "first.pdf",
      "a".repeat(64),
      "files/aa/first.blob",
      "2026-07-29T08:01:00.000Z",
      "2026-07-29T08:01:00.000Z"
    );
    insertAttachment.run(
      "attachment:v8-second",
      onboarding.family.familyRef,
      onboarding.owner.personRef,
      "second.pdf",
      "b".repeat(64),
      "files/bb/second.blob",
      "2026-07-29T08:01:00.000Z",
      "2026-07-29T08:01:00.000Z"
    );
    db.prepare(
      `INSERT INTO message_attachments
       (message_ref, attachment_ref, attachment_order) VALUES(?, ?, 0)`
    ).run("message:v8-empty-text", "attachment:v8-first");

    expect(() => db!.prepare(
      `INSERT INTO message_attachments
       (message_ref, attachment_ref, attachment_order) VALUES(?, ?, 1)`
    ).run(original.messageRef, "attachment:v8-first")).toThrow();
    expect(() => db!.prepare(
      `INSERT INTO message_attachments
       (message_ref, attachment_ref, attachment_order) VALUES(?, ?, 0)`
    ).run("message:v8-empty-text", "attachment:v8-second")).toThrow();
    expect(() => db!.prepare(
      `INSERT INTO message_attachments
       (message_ref, attachment_ref, attachment_order) VALUES(?, ?, 1)`
    ).run("message:v8-missing", "attachment:v8-second")).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    db = openGatewayDatabase(databasePath);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM message_attachments").get()
    ).toEqual({ count: 1 });
  });
});
