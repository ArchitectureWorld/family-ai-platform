import { randomUUID } from "node:crypto";
import type {
  DailyEpisode,
  HomeChatStream,
  WorkConversation,
  WorkConversationStatus
} from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

export interface HomeChatRecord {
  chat: HomeChatStream;
  currentEpisode: DailyEpisode | null;
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
