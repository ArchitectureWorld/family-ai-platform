import { randomUUID } from "node:crypto";
import type {
  DailyEpisode,
  HomeChatStream,
  ThreadActor,
  ThreadMessage,
  ThreadMessageContent,
  ThreadMessageOrigin,
  WorkConversation,
  WorkConversationStatus
} from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

export interface HomeChatRecord {
  chat: HomeChatStream;
  currentEpisode: DailyEpisode | null;
}

export interface ThreadMessagePage {
  threadRef: string;
  messages: ThreadMessage[];
  nextBeforeSequence: number | null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function requirePerson(db: GatewayDatabase, personRef: string): void {
  const row = db.prepare(
    "SELECT 1 FROM persons WHERE person_ref = ? AND status = 'active'"
  ).get(personRef);
  if (!row) {
    throw new GatewayDomainError(
      "PERSON_NOT_FOUND",
      404,
      "permission",
      false,
      "没有找到这个家庭成员。"
    );
  }
}

function threadNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "THREAD_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到这个对话线程。"
  );
}

function mapHomeChatRecord(row: Record<string, unknown>): HomeChatRecord {
  const currentEpisodeRef = nullableString(row.daily_episode_ref);
  const currentEpisode: DailyEpisode | null = currentEpisodeRef
    ? {
        dailyEpisodeRef: currentEpisodeRef,
        homeChatStreamRef: String(row.home_chat_stream_ref),
        threadRef: String(row.thread_ref),
        localDate: String(row.local_date),
        timezone: String(row.timezone),
        startedAt: String(row.started_at),
        endedAt: nullableString(row.ended_at),
        boundaryReason: row.boundary_reason as DailyEpisode["boundaryReason"],
        archiveStatus: row.archive_status as DailyEpisode["archiveStatus"],
        archiveVersion: Number(row.archive_version),
        lastMessageSequence: Number(row.last_message_sequence)
      }
    : null;

  return {
    chat: {
      threadRef: String(row.thread_ref),
      threadKind: "home_chat",
      personRef: String(row.person_ref),
      lastSequence: Number(row.thread_last_sequence),
      createdAt: String(row.thread_created_at),
      lastActiveAt: String(row.thread_last_active_at),
      homeChatStreamRef: String(row.home_chat_stream_ref),
      status: row.home_chat_status as HomeChatStream["status"],
      currentEpisodeRef
    },
    currentEpisode
  };
}

function mapWorkConversation(row: Record<string, unknown>): WorkConversation {
  return {
    threadRef: String(row.thread_ref),
    threadKind: "work",
    personRef: String(row.person_ref),
    lastSequence: Number(row.last_sequence),
    createdAt: String(row.created_at),
    lastActiveAt: String(row.last_active_at),
    workConversationRef: String(row.work_conversation_ref),
    title: String(row.title),
    goal: String(row.goal),
    summary: String(row.summary),
    status: row.status as WorkConversationStatus,
    archivedAt: nullableString(row.archived_at)
  };
}

function mapThreadActor(row: Record<string, unknown>): ThreadActor {
  switch (row.actor_type) {
    case "person":
      return {
        type: "person",
        personRef: String(row.actor_person_ref)
      };
    case "assistant":
      return {
        type: "assistant",
        assignmentRef: String(row.actor_assignment_ref),
        agentRef: String(row.actor_agent_ref),
        providerProfileRef: String(row.actor_provider_profile_ref)
      };
    case "agent":
      return {
        type: "agent",
        agentRef: String(row.actor_agent_ref),
        providerProfileRef: String(row.actor_provider_profile_ref)
      };
    case "system":
      return {
        type: "system",
        systemRef: String(row.actor_system_ref)
      };
    default:
      throw new Error(`Unsupported Thread actor type: ${String(row.actor_type)}`);
  }
}

function mapThreadMessage(row: Record<string, unknown>): ThreadMessage {
  const language = nullableString(row.content_language);
  const content: ThreadMessageContent = language
    ? {
        type: "text",
        text: String(row.content_text),
        language
      }
    : {
        type: "text",
        text: String(row.content_text)
      };

  return {
    messageRef: String(row.message_ref),
    threadRef: String(row.thread_ref),
    threadSequence: Number(row.thread_sequence),
    clientMessageId: String(row.client_message_id),
    actor: mapThreadActor(row),
    origin: {
      deviceRef: nullableString(row.origin_device_ref),
      connectionRef: nullableString(row.origin_connection_ref),
      entryAudience: row.entry_audience as ThreadMessageOrigin["entryAudience"]
    },
    content,
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at)
  };
}

function normalizedRequired(value: string, field: "title" | "goal"): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new GatewayDomainError(
      "REQUEST_INVALID",
      400,
      "validation",
      false,
      field === "title" ? "Work 标题不能为空。" : "Work 目标不能为空。"
    );
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function logicalMessageFingerprint(input: {
  actor: ThreadActor;
  origin: ThreadMessageOrigin;
  content: ThreadMessageContent;
  occurredAt: string;
}): string {
  return canonicalJson({
    actor: input.actor,
    origin: input.origin,
    content: input.content,
    occurredAt: input.occurredAt
  });
}

function actorColumns(actor: ThreadActor): {
  actorType: ThreadActor["type"];
  personRef: string | null;
  assignmentRef: string | null;
  agentRef: string | null;
  providerProfileRef: string | null;
  systemRef: string | null;
} {
  switch (actor.type) {
    case "person":
      return {
        actorType: actor.type,
        personRef: actor.personRef,
        assignmentRef: null,
        agentRef: null,
        providerProfileRef: null,
        systemRef: null
      };
    case "assistant":
      return {
        actorType: actor.type,
        personRef: null,
        assignmentRef: actor.assignmentRef,
        agentRef: actor.agentRef,
        providerProfileRef: actor.providerProfileRef,
        systemRef: null
      };
    case "agent":
      return {
        actorType: actor.type,
        personRef: null,
        assignmentRef: null,
        agentRef: actor.agentRef,
        providerProfileRef: actor.providerProfileRef,
        systemRef: null
      };
    case "system":
      return {
        actorType: actor.type,
        personRef: null,
        assignmentRef: null,
        agentRef: null,
        providerProfileRef: null,
        systemRef: actor.systemRef
      };
  }
}

export class ChatWorkDomainRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  ensureHomeChat(input: {
    personRef: string;
    timezone: string;
    localDate?: string;
  }): HomeChatRecord {
    const existing = this.getHomeChat(input.personRef);
    if (existing) return existing;

    requirePerson(this.db, input.personRef);
    const create = this.db.transaction(() => {
      const concurrentExisting = this.getHomeChat(input.personRef);
      if (concurrentExisting) return concurrentExisting;

      const now = this.now().toISOString();
      const localDate = input.localDate ?? now.slice(0, 10);
      const threadRef = `thread:${randomUUID()}`;
      const homeChatStreamRef = `home-chat:${randomUUID()}`;
      const dailyEpisodeRef = `daily-episode:${randomUUID()}`;

      this.db.prepare(
        `INSERT INTO interaction_threads
         (thread_ref, person_ref, thread_kind, last_sequence, created_at, last_active_at)
         VALUES(?, ?, 'home_chat', 0, ?, ?)`
      ).run(threadRef, input.personRef, now, now);
      this.db.prepare(
        `INSERT INTO home_chat_streams
         (home_chat_stream_ref, thread_ref, person_ref, status)
         VALUES(?, ?, ?, 'active')`
      ).run(homeChatStreamRef, threadRef, input.personRef);
      this.db.prepare(
        `INSERT INTO daily_episodes
         (daily_episode_ref, home_chat_stream_ref, thread_ref, local_date, timezone,
          started_at, ended_at, boundary_reason, archive_status, archive_version,
          last_message_sequence)
         VALUES(?, ?, ?, ?, ?, ?, NULL, 'initial', 'open', 0, 0)`
      ).run(
        dailyEpisodeRef,
        homeChatStreamRef,
        threadRef,
        localDate,
        input.timezone,
        now
      );

      const created = this.getHomeChat(input.personRef);
      if (!created) throw new Error("Home Chat was not readable after creation");
      return created;
    });

    return create();
  }

  getHomeChat(personRef: string): HomeChatRecord | null {
    const row = this.db.prepare(
      `SELECT t.thread_ref,
              t.person_ref,
              t.last_sequence AS thread_last_sequence,
              t.created_at AS thread_created_at,
              t.last_active_at AS thread_last_active_at,
              h.home_chat_stream_ref,
              h.status AS home_chat_status,
              e.daily_episode_ref,
              e.local_date,
              e.timezone,
              e.started_at,
              e.ended_at,
              e.boundary_reason,
              e.archive_status,
              e.archive_version,
              e.last_message_sequence
       FROM home_chat_streams h
       JOIN interaction_threads t
         ON t.thread_ref = h.thread_ref
        AND t.person_ref = h.person_ref
        AND t.thread_kind = 'home_chat'
       LEFT JOIN daily_episodes e
         ON e.home_chat_stream_ref = h.home_chat_stream_ref
        AND e.thread_ref = h.thread_ref
        AND e.archive_status = 'open'
       WHERE h.person_ref = ? AND h.status = 'active'`
    ).get(personRef) as Record<string, unknown> | undefined;
    return row ? mapHomeChatRecord(row) : null;
  }

  createWorkConversation(input: {
    personRef: string;
    title: string;
    goal: string;
  }): WorkConversation {
    requirePerson(this.db, input.personRef);
    const title = normalizedRequired(input.title, "title");
    const goal = normalizedRequired(input.goal, "goal");
    const create = this.db.transaction(() => this.insertWorkConversation({
      personRef: input.personRef,
      title,
      goal,
      now: this.now().toISOString()
    }));
    return create();
  }

  getWorkConversation(
    personRef: string,
    workConversationRef: string
  ): WorkConversation | null {
    const row = this.db.prepare(
      `SELECT t.thread_ref, t.person_ref, t.last_sequence, t.created_at, t.last_active_at,
              w.work_conversation_ref, w.title, w.goal, w.summary, w.status, w.archived_at
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.thread_kind = 'work'
       WHERE w.work_conversation_ref = ? AND w.person_ref = ?`
    ).get(workConversationRef, personRef) as Record<string, unknown> | undefined;
    return row ? mapWorkConversation(row) : null;
  }

  listWorkConversations(personRef: string): WorkConversation[] {
    const rows = this.db.prepare(
      `SELECT t.thread_ref, t.person_ref, t.last_sequence, t.created_at, t.last_active_at,
              w.work_conversation_ref, w.title, w.goal, w.summary, w.status, w.archived_at
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.thread_kind = 'work'
       WHERE w.person_ref = ?
       ORDER BY t.last_active_at DESC, t.created_at DESC, w.work_conversation_ref`
    ).all(personRef) as Array<Record<string, unknown>>;
    return rows.map(mapWorkConversation);
  }

  appendThreadMessage(input: {
    personRef: string;
    threadRef: string;
    clientMessageId: string;
    actor: ThreadActor;
    origin: ThreadMessageOrigin;
    content: ThreadMessageContent;
    occurredAt: string;
  }): ThreadMessage {
    if (input.actor.type === "person" && input.actor.personRef !== input.personRef) {
      throw new GatewayDomainError(
        "THREAD_MESSAGE_INVALID",
        400,
        "validation",
        false,
        "消息发送者与当前家庭成员不一致。"
      );
    }

    const append = this.db.transaction(() => {
      this.requireThread(input.personRef, input.threadRef);
      const existing = this.findMessageByClientId(input.threadRef, input.clientMessageId);
      if (existing) {
        const existingFingerprint = logicalMessageFingerprint({
          actor: existing.actor,
          origin: existing.origin,
          content: existing.content,
          occurredAt: existing.occurredAt
        });
        const incomingFingerprint = logicalMessageFingerprint(input);
        if (existingFingerprint !== incomingFingerprint) {
          throw new GatewayDomainError(
            "THREAD_MESSAGE_CONFLICT",
            409,
            "conflict",
            false,
            "同一个客户端消息编号已经用于不同内容。"
          );
        }
        return existing;
      }

      const now = this.now().toISOString();
      const sequenceRow = this.db.prepare(
        `UPDATE interaction_threads
         SET last_sequence = last_sequence + 1, last_active_at = ?
         WHERE thread_ref = ? AND person_ref = ?
         RETURNING last_sequence`
      ).get(now, input.threadRef, input.personRef) as { last_sequence: number } | undefined;
      if (!sequenceRow) throw threadNotFound();

      const messageRef = `message:${randomUUID()}`;
      const actor = actorColumns(input.actor);
      this.db.prepare(
        `INSERT INTO thread_messages
         (message_ref, thread_ref, thread_sequence, client_message_id,
          actor_type, actor_person_ref, actor_assignment_ref, actor_agent_ref,
          actor_provider_profile_ref, actor_system_ref,
          origin_device_ref, origin_connection_ref, entry_audience,
          content_type, content_text, content_language, occurred_at, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)`
      ).run(
        messageRef,
        input.threadRef,
        sequenceRow.last_sequence,
        input.clientMessageId,
        actor.actorType,
        actor.personRef,
        actor.assignmentRef,
        actor.agentRef,
        actor.providerProfileRef,
        actor.systemRef,
        input.origin.deviceRef,
        input.origin.connectionRef,
        input.origin.entryAudience,
        input.content.text,
        input.content.language ?? null,
        input.occurredAt,
        now
      );
      this.db.prepare(
        `UPDATE daily_episodes
         SET last_message_sequence = ?
         WHERE thread_ref = ? AND archive_status = 'open'`
      ).run(sequenceRow.last_sequence, input.threadRef);

      const message = this.getMessageByRef(messageRef);
      if (!message) throw new Error("Thread Message was not readable after creation");
      return message;
    });

    return append();
  }

  listThreadMessages(input: {
    personRef: string;
    threadRef: string;
    beforeSequence?: number;
    limit?: number;
  }): ThreadMessagePage {
    this.requireThread(input.personRef, input.threadRef);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = input.beforeSequence === undefined
      ? this.db.prepare(
          `SELECT * FROM thread_messages
           WHERE thread_ref = ?
           ORDER BY thread_sequence DESC
           LIMIT ?`
        ).all(input.threadRef, limit + 1)
      : this.db.prepare(
          `SELECT * FROM thread_messages
           WHERE thread_ref = ? AND thread_sequence < ?
           ORDER BY thread_sequence DESC
           LIMIT ?`
        ).all(input.threadRef, input.beforeSequence, limit + 1);
    const typedRows = rows as Array<Record<string, unknown>>;
    const hasMore = typedRows.length > limit;
    const messages = typedRows.slice(0, limit).reverse().map(mapThreadMessage);
    return {
      threadRef: input.threadRef,
      messages,
      nextBeforeSequence: hasMore && messages.length > 0
        ? messages[0]!.threadSequence
        : null
    };
  }

  private requireThread(personRef: string, threadRef: string): void {
    const row = this.db.prepare(
      `SELECT 1 FROM interaction_threads
       WHERE thread_ref = ? AND person_ref = ?`
    ).get(threadRef, personRef);
    if (!row) throw threadNotFound();
  }

  private findMessageByClientId(
    threadRef: string,
    clientMessageId: string
  ): ThreadMessage | null {
    const row = this.db.prepare(
      `SELECT * FROM thread_messages
       WHERE thread_ref = ? AND client_message_id = ?`
    ).get(threadRef, clientMessageId) as Record<string, unknown> | undefined;
    return row ? mapThreadMessage(row) : null;
  }

  private getMessageByRef(messageRef: string): ThreadMessage | null {
    const row = this.db.prepare(
      "SELECT * FROM thread_messages WHERE message_ref = ?"
    ).get(messageRef) as Record<string, unknown> | undefined;
    return row ? mapThreadMessage(row) : null;
  }

  private insertWorkConversation(input: {
    personRef: string;
    title: string;
    goal: string;
    now: string;
  }): WorkConversation {
    const threadRef = `thread:${randomUUID()}`;
    const workConversationRef = `work:${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO interaction_threads
       (thread_ref, person_ref, thread_kind, last_sequence, created_at, last_active_at)
       VALUES(?, ?, 'work', 0, ?, ?)`
    ).run(threadRef, input.personRef, input.now, input.now);
    this.db.prepare(
      `INSERT INTO work_conversations
       (work_conversation_ref, thread_ref, person_ref, title, goal, summary, status, archived_at)
       VALUES(?, ?, ?, ?, ?, '', 'active', NULL)`
    ).run(
      workConversationRef,
      threadRef,
      input.personRef,
      input.title,
      input.goal
    );

    const work = this.getWorkConversation(input.personRef, workConversationRef);
    if (!work) throw new Error("Work Conversation was not readable after creation");
    return work;
  }
}
