import { randomUUID } from "node:crypto";
import type {
  ChatWorkConversion,
  DailyEpisode,
  HomeChatStream,
  ThreadActor,
  ThreadMessage,
  ThreadMessageContent,
  ThreadMessageOrigin,
  WorkConversation,
  WorkConversationStatus,
  WorkProgressSnapshot
} from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";
import { AgentManagementRepository } from "./agentManagement.js";
import { requireAdminAgentAssignment } from "./adminWorkspace.js";
import { GatewayDomainError } from "./service.js";

const PERSONAL_AGENT_REF = "agent:personal-assistant";

export interface HomeChatRecord {
  chat: HomeChatStream;
  currentEpisode: DailyEpisode | null;
}

export interface ThreadAccessContext {
  personRef: string;
  familyRef: string | null;
  entryAudience: "personal" | "family_admin";
  agentRef: string;
}

export interface ThreadMessagePage {
  threadRef: string;
  messages: ThreadMessage[];
  nextBeforeSequence: number | null;
}

export interface ChatWorkConversionRecord extends ChatWorkConversion {
  decisions: string[];
  openQuestions: string[];
}

export interface CreateWorkFromChatResult {
  conversation: WorkConversation;
  conversion: ChatWorkConversion;
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

function workNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "WORK_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到这个 Work。"
  );
}

function chatSourceInvalid(): GatewayDomainError {
  return new GatewayDomainError(
    "CHAT_SOURCE_INVALID",
    400,
    "validation",
    false,
    "Chat 转 Work 的来源消息无效。"
  );
}

function messageInvalid(message: string): GatewayDomainError {
  return new GatewayDomainError(
    "THREAD_MESSAGE_INVALID",
    400,
    "validation",
    false,
    message
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
      agentRef: String(row.agent_ref),
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
    agentRef: String(row.agent_ref),
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

function parseStringArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Stored Chat Work string array is invalid");
  }
  return parsed;
}

function mapWorkProgressSnapshot(row: Record<string, unknown>): WorkProgressSnapshot {
  const deadlines = JSON.parse(String(row.deadlines_json)) as WorkProgressSnapshot["deadlines"];
  return {
    workConversationRef: String(row.work_conversation_ref),
    status: row.status as WorkConversationStatus,
    phaseSummary: String(row.phase_summary),
    incompleteTasks: parseStringArray(row.incomplete_tasks_json),
    risks: parseStringArray(row.risks_json),
    pendingConfirmations: parseStringArray(row.pending_confirmations_json),
    deadlines,
    updatedAt: String(row.updated_at)
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
  content: ThreadMessageContent;
  occurredAt: string;
}): string {
  return canonicalJson({
    actor: input.actor,
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
  private readonly agentManagement: AgentManagementRepository;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date(),
    agentManagement?: AgentManagementRepository
  ) {
    this.agentManagement = agentManagement ?? new AgentManagementRepository(db, now);
  }

  requireActiveAgent(personRef: string, agentRef: string): void {
    this.agentManagement.requireActiveMount(personRef, agentRef);
  }

  ensureHomeChat(input: {
    personRef: string;
    agentRef?: string;
    timezone: string;
    localDate?: string;
  }): HomeChatRecord {
    const agentRef = input.agentRef ?? PERSONAL_AGENT_REF;
    this.agentManagement.requireActiveMount(input.personRef, agentRef);
    const existing = this.getHomeChat(input.personRef, agentRef);
    if (existing) return existing;

    requirePerson(this.db, input.personRef);
    const create = this.db.transaction(() => {
      this.agentManagement.requireActiveMount(input.personRef, agentRef);
      const concurrentExisting = this.getHomeChat(input.personRef, agentRef);
      if (concurrentExisting) return concurrentExisting;

      const now = this.now().toISOString();
      const localDate = input.localDate ?? now.slice(0, 10);
      const threadRef = `thread:${randomUUID()}`;
      const homeChatStreamRef = `home-chat:${randomUUID()}`;
      const dailyEpisodeRef = `daily-episode:${randomUUID()}`;

      this.db.prepare(
        `INSERT INTO interaction_threads
         (thread_ref, person_ref, family_ref, agent_ref, entry_audience,
          thread_kind, last_sequence, created_at, last_active_at)
         VALUES(?, ?, NULL, ?, 'personal', 'home_chat', 0, ?, ?)`
      ).run(threadRef, input.personRef, agentRef, now, now);
      this.db.prepare(
        `INSERT INTO home_chat_streams
         (home_chat_stream_ref, thread_ref, person_ref, agent_ref, entry_audience, status)
         VALUES(?, ?, ?, ?, 'personal', 'active')`
      ).run(homeChatStreamRef, threadRef, input.personRef, agentRef);
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

      const created = this.getHomeChat(input.personRef, agentRef);
      if (!created) throw new Error("Home Chat was not readable after creation");
      return created;
    });

    return create();
  }

  getHomeChat(
    personRef: string,
    agentRef: string = PERSONAL_AGENT_REF
  ): HomeChatRecord | null {
    try {
      this.agentManagement.requireActiveMount(personRef, agentRef);
    } catch (error) {
      if (error instanceof GatewayDomainError && error.code === "AGENT_NOT_MOUNTED") {
        return null;
      }
      throw error;
    }
    const row = this.db.prepare(
      `SELECT t.thread_ref,
              t.person_ref,
              t.agent_ref,
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
       WHERE h.person_ref = ? AND h.agent_ref = ?
         AND h.entry_audience = 'personal' AND h.status = 'active'`
    ).get(personRef, agentRef) as Record<string, unknown> | undefined;
    return row ? mapHomeChatRecord(row) : null;
  }

  ensureAdminHomeChat(context: ThreadAccessContext): HomeChatRecord {
    this.requireAdminContext(context);
    const existing = this.getAdminHomeChat(context);
    if (existing) return existing;
    const create = this.db.transaction(() => {
      this.requireAdminContext(context);
      const concurrent = this.getAdminHomeChat(context);
      if (concurrent) return concurrent;
      const now = this.now().toISOString();
      const threadRef = `thread:${randomUUID()}`;
      const homeChatStreamRef = `home-chat:${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO interaction_threads
         (thread_ref, person_ref, family_ref, agent_ref, entry_audience,
          thread_kind, last_sequence, created_at, last_active_at)
         VALUES(?, ?, ?, ?, 'family_admin', 'home_chat', 0, ?, ?)`
      ).run(
        threadRef,
        context.personRef,
        context.familyRef,
        context.agentRef,
        now,
        now
      );
      this.db.prepare(
        `INSERT INTO home_chat_streams
         (home_chat_stream_ref, thread_ref, person_ref, agent_ref, entry_audience, status)
         VALUES(?, ?, ?, ?, 'family_admin', 'active')`
      ).run(homeChatStreamRef, threadRef, context.personRef, context.agentRef);
      const created = this.getAdminHomeChat(context);
      if (!created) throw new Error("Admin Home Chat was not readable after creation");
      return created;
    });
    return create();
  }

  getAdminHomeChat(context: ThreadAccessContext): HomeChatRecord | null {
    this.requireAdminContext(context);
    const row = this.db.prepare(
      `SELECT t.thread_ref, t.person_ref, t.agent_ref,
              t.last_sequence AS thread_last_sequence,
              t.created_at AS thread_created_at,
              t.last_active_at AS thread_last_active_at,
              h.home_chat_stream_ref, h.status AS home_chat_status,
              NULL AS daily_episode_ref, NULL AS local_date, NULL AS timezone,
              NULL AS started_at, NULL AS ended_at, NULL AS boundary_reason,
              NULL AS archive_status, NULL AS archive_version,
              NULL AS last_message_sequence
       FROM home_chat_streams h
       JOIN interaction_threads t
         ON t.thread_ref = h.thread_ref
        AND t.person_ref = h.person_ref
        AND t.agent_ref = h.agent_ref
        AND t.entry_audience = h.entry_audience
        AND t.thread_kind = 'home_chat'
       WHERE t.family_ref = ? AND h.person_ref = ? AND h.agent_ref = ?
         AND h.entry_audience = 'family_admin' AND h.status = 'active'`
    ).get(
      context.familyRef,
      context.personRef,
      context.agentRef
    ) as Record<string, unknown> | undefined;
    return row ? mapHomeChatRecord(row) : null;
  }

  createWorkConversation(input: {
    personRef: string;
    agentRef?: string;
    title: string;
    goal: string;
  }): WorkConversation {
    const agentRef = input.agentRef ?? PERSONAL_AGENT_REF;
    requirePerson(this.db, input.personRef);
    this.agentManagement.requireActiveMount(input.personRef, agentRef);
    const title = normalizedRequired(input.title, "title");
    const goal = normalizedRequired(input.goal, "goal");
    const create = this.db.transaction(() => this.insertWorkConversation({
      personRef: input.personRef,
      agentRef,
      title,
      goal,
      now: this.now().toISOString()
    }));
    return create();
  }

  getWorkConversation(
    personRef: string,
    agentRefOrWorkConversationRef: string,
    maybeWorkConversationRef?: string
  ): WorkConversation | null {
    const agentRef = maybeWorkConversationRef === undefined
      ? PERSONAL_AGENT_REF
      : agentRefOrWorkConversationRef;
    const workConversationRef = maybeWorkConversationRef ?? agentRefOrWorkConversationRef;
    try {
      this.agentManagement.requireActiveMount(personRef, agentRef);
    } catch (error) {
      if (error instanceof GatewayDomainError && error.code === "AGENT_NOT_MOUNTED") {
        return null;
      }
      throw error;
    }
    const row = this.db.prepare(
      `SELECT t.thread_ref, t.person_ref, t.agent_ref, t.last_sequence,
              t.created_at, t.last_active_at,
              w.work_conversation_ref, w.title, w.goal, w.summary, w.status, w.archived_at
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.thread_kind = 'work'
       WHERE w.work_conversation_ref = ? AND w.person_ref = ?
         AND w.agent_ref = ? AND w.entry_audience = 'personal'`
    ).get(workConversationRef, personRef, agentRef) as Record<string, unknown> | undefined;
    return row ? mapWorkConversation(row) : null;
  }

  listWorkConversations(
    personRef: string,
    agentRef: string = PERSONAL_AGENT_REF
  ): WorkConversation[] {
    this.agentManagement.requireActiveMount(personRef, agentRef);
    const rows = this.db.prepare(
      `SELECT t.thread_ref, t.person_ref, t.agent_ref, t.last_sequence,
              t.created_at, t.last_active_at,
              w.work_conversation_ref, w.title, w.goal, w.summary, w.status, w.archived_at
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.thread_kind = 'work'
       WHERE w.person_ref = ? AND w.agent_ref = ? AND w.entry_audience = 'personal'
       ORDER BY t.last_active_at DESC, t.created_at DESC, w.work_conversation_ref`
    ).all(personRef, agentRef) as Array<Record<string, unknown>>;
    return rows.map(mapWorkConversation);
  }

  createAdminWorkConversation(input: {
    context: ThreadAccessContext;
    title: string;
    goal: string;
  }): WorkConversation {
    this.requireAdminContext(input.context);
    const title = normalizedRequired(input.title, "title");
    const goal = normalizedRequired(input.goal, "goal");
    const create = this.db.transaction(() => {
      this.requireAdminContext(input.context);
      const now = this.now().toISOString();
      const threadRef = `thread:${randomUUID()}`;
      const workConversationRef = `work:${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO interaction_threads
         (thread_ref, person_ref, family_ref, agent_ref, entry_audience,
          thread_kind, last_sequence, created_at, last_active_at)
         VALUES(?, ?, ?, ?, 'family_admin', 'work', 0, ?, ?)`
      ).run(
        threadRef,
        input.context.personRef,
        input.context.familyRef,
        input.context.agentRef,
        now,
        now
      );
      this.db.prepare(
        `INSERT INTO work_conversations
         (work_conversation_ref, thread_ref, person_ref, agent_ref, entry_audience,
          title, goal, summary, status, archived_at)
         VALUES(?, ?, ?, ?, 'family_admin', ?, ?, '', 'active', NULL)`
      ).run(
        workConversationRef,
        threadRef,
        input.context.personRef,
        input.context.agentRef,
        title,
        goal
      );
      const row = this.adminWorkRow(input.context, workConversationRef);
      if (!row) throw new Error("Admin Work Conversation was not readable after creation");
      return mapWorkConversation(row);
    });
    return create();
  }

  listAdminWorkConversations(context: ThreadAccessContext): WorkConversation[] {
    this.requireAdminContext(context);
    const rows = this.db.prepare(
      `SELECT t.thread_ref, t.person_ref, t.agent_ref, t.last_sequence,
              t.created_at, t.last_active_at,
              w.work_conversation_ref, w.title, w.goal, w.summary, w.status, w.archived_at
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.agent_ref = w.agent_ref
        AND t.entry_audience = w.entry_audience
        AND t.thread_kind = 'work'
       WHERE t.family_ref = ? AND w.person_ref = ? AND w.agent_ref = ?
         AND w.entry_audience = 'family_admin'
       ORDER BY t.last_active_at DESC, t.created_at DESC, w.work_conversation_ref`
    ).all(
      context.familyRef,
      context.personRef,
      context.agentRef
    ) as Array<Record<string, unknown>>;
    return rows.map(mapWorkConversation);
  }

  appendThreadMessage(input: {
    personRef: string;
    familyRef?: string | null;
    agentRef?: string;
    entryAudience?: "personal" | "family_admin";
    threadRef: string;
    clientMessageId: string;
    actor: ThreadActor;
    origin: ThreadMessageOrigin;
    content: ThreadMessageContent;
    occurredAt: string;
  }): ThreadMessage {
    const agentRef = input.agentRef ?? PERSONAL_AGENT_REF;
    const entryAudience = input.entryAudience ?? "personal";
    const append = this.db.transaction(() => {
      this.requireThread({
        personRef: input.personRef,
        familyRef: input.familyRef ?? null,
        agentRef,
        entryAudience,
        threadRef: input.threadRef
      });
      this.validateMessageProvenance(input.personRef, input.actor, input.origin);
      const existing = this.findMessageByClientId(input.threadRef, input.clientMessageId);
      if (existing) {
        const existingFingerprint = logicalMessageFingerprint({
          actor: existing.actor,
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
    familyRef?: string | null;
    agentRef?: string;
    entryAudience?: "personal" | "family_admin";
    threadRef: string;
    beforeSequence?: number;
    limit?: number;
  }): ThreadMessagePage {
    this.requireThread({
      personRef: input.personRef,
      familyRef: input.familyRef ?? null,
      agentRef: input.agentRef ?? PERSONAL_AGENT_REF,
      entryAudience: input.entryAudience ?? "personal",
      threadRef: input.threadRef
    });
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

  createWorkFromChat(input: {
    personRef: string;
    title: string;
    goal: string;
    source: {
      homeChatStreamRef: string;
      dailyEpisodeRef: string | null;
      messageRefs: string[];
    };
    decisions: string[];
    openQuestions: string[];
  }): CreateWorkFromChatResult {
    requirePerson(this.db, input.personRef);
    const title = normalizedRequired(input.title, "title");
    const goal = normalizedRequired(input.goal, "goal");
    if (
      input.source.messageRefs.length === 0 ||
      new Set(input.source.messageRefs).size !== input.source.messageRefs.length
    ) {
      throw chatSourceInvalid();
    }

    const create = this.db.transaction(() => {
      const homeChat = this.db.prepare(
        `SELECT h.thread_ref, h.agent_ref
         FROM home_chat_streams h
         JOIN interaction_threads t
           ON t.thread_ref = h.thread_ref
          AND t.person_ref = h.person_ref
          AND t.agent_ref = h.agent_ref
          AND t.entry_audience = h.entry_audience
          AND t.thread_kind = 'home_chat'
         WHERE h.home_chat_stream_ref = ?
           AND h.person_ref = ?
           AND h.entry_audience = 'personal'
           AND h.status = 'active'`
      ).get(
        input.source.homeChatStreamRef,
        input.personRef
      ) as { thread_ref: string; agent_ref: string } | undefined;
      if (!homeChat) throw chatSourceInvalid();
      this.agentManagement.requireActiveMount(input.personRef, homeChat.agent_ref);

      if (input.source.dailyEpisodeRef) {
        const episode = this.db.prepare(
          `SELECT 1 FROM daily_episodes
           WHERE daily_episode_ref = ?
             AND home_chat_stream_ref = ?
             AND thread_ref = ?`
        ).get(
          input.source.dailyEpisodeRef,
          input.source.homeChatStreamRef,
          homeChat.thread_ref
        );
        if (!episode) throw chatSourceInvalid();
      }

      const placeholders = input.source.messageRefs.map(() => "?").join(", ");
      const sourceRows = this.db.prepare(
        `SELECT message_ref FROM thread_messages
         WHERE thread_ref = ? AND message_ref IN (${placeholders})`
      ).all(
        homeChat.thread_ref,
        ...input.source.messageRefs
      ) as Array<{ message_ref: string }>;
      if (sourceRows.length !== input.source.messageRefs.length) {
        throw chatSourceInvalid();
      }

      const now = this.now().toISOString();
      const conversation = this.insertWorkConversation({
        personRef: input.personRef,
        agentRef: homeChat.agent_ref,
        title,
        goal,
        now
      });
      const conversionRef = `chat-work-conversion:${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO chat_work_conversions
         (conversion_ref, person_ref, home_chat_stream_ref, daily_episode_ref,
          work_conversation_ref, decisions_json, open_questions_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        conversionRef,
        input.personRef,
        input.source.homeChatStreamRef,
        input.source.dailyEpisodeRef,
        conversation.workConversationRef,
        JSON.stringify(input.decisions),
        JSON.stringify(input.openQuestions),
        now
      );
      const insertMessage = this.db.prepare(
        `INSERT INTO chat_work_conversion_messages
         (conversion_ref, message_ref, source_order)
         VALUES(?, ?, ?)`
      );
      input.source.messageRefs.forEach((messageRef, sourceOrder) => {
        insertMessage.run(conversionRef, messageRef, sourceOrder);
      });

      const stored = this.getChatWorkConversion(input.personRef, conversionRef);
      if (!stored) throw new Error("Chat Work conversion was not readable after creation");
      const conversion: ChatWorkConversion = {
        conversionRef: stored.conversionRef,
        homeChatStreamRef: stored.homeChatStreamRef,
        dailyEpisodeRef: stored.dailyEpisodeRef,
        sourceMessageRefs: stored.sourceMessageRefs,
        workConversationRef: stored.workConversationRef,
        createdAt: stored.createdAt
      };
      return { conversation, conversion };
    });

    return create();
  }

  getChatWorkConversion(
    personRef: string,
    conversionRef: string
  ): ChatWorkConversionRecord | null {
    const read = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT c.conversion_ref, c.home_chat_stream_ref, c.daily_episode_ref,
                c.work_conversation_ref, c.decisions_json, c.open_questions_json,
                c.created_at, h.thread_ref AS source_thread_ref, h.agent_ref
         FROM chat_work_conversions c
         JOIN home_chat_streams h
           ON h.home_chat_stream_ref = c.home_chat_stream_ref
          AND h.person_ref = c.person_ref
          AND h.entry_audience = 'personal'
         JOIN interaction_threads source_thread
           ON source_thread.thread_ref = h.thread_ref
          AND source_thread.person_ref = h.person_ref
          AND source_thread.agent_ref = h.agent_ref
          AND source_thread.entry_audience = h.entry_audience
          AND source_thread.thread_kind = 'home_chat'
         JOIN work_conversations w
           ON w.work_conversation_ref = c.work_conversation_ref
          AND w.person_ref = c.person_ref
          AND w.agent_ref = h.agent_ref
          AND w.entry_audience = 'personal'
         JOIN interaction_threads work_thread
           ON work_thread.thread_ref = w.thread_ref
          AND work_thread.person_ref = w.person_ref
          AND work_thread.agent_ref = w.agent_ref
          AND work_thread.entry_audience = w.entry_audience
          AND work_thread.thread_kind = 'work'
         WHERE c.conversion_ref = ? AND c.person_ref = ?`
      ).get(conversionRef, personRef) as Record<string, unknown> | undefined;
      if (!row) return null;

      this.agentManagement.requireActiveMount(personRef, String(row.agent_ref));
      const messageRows = this.db.prepare(
        `SELECT conversion_message.message_ref
         FROM chat_work_conversion_messages conversion_message
         JOIN thread_messages message
           ON message.message_ref = conversion_message.message_ref
          AND message.thread_ref = ?
         WHERE conversion_message.conversion_ref = ?
         ORDER BY conversion_message.source_order`
      ).all(row.source_thread_ref, conversionRef) as Array<{ message_ref: string }>;
      return {
        conversionRef: String(row.conversion_ref),
        homeChatStreamRef: String(row.home_chat_stream_ref),
        dailyEpisodeRef: nullableString(row.daily_episode_ref),
        sourceMessageRefs: messageRows.map((item) => String(item.message_ref)),
        workConversationRef: String(row.work_conversation_ref),
        createdAt: String(row.created_at),
        decisions: parseStringArray(row.decisions_json),
        openQuestions: parseStringArray(row.open_questions_json)
      };
    });
    return read();
  }

  saveWorkProgressSnapshot(input: {
    personRef: string;
    snapshot: WorkProgressSnapshot;
  }): WorkProgressSnapshot {
    const save = this.db.transaction(() => {
      const agentRef = this.resolveWorkAgent(
        input.personRef,
        input.snapshot.workConversationRef
      );
      if (!agentRef) {
        throw workNotFound();
      }
      this.db.prepare(
        `INSERT INTO work_progress_snapshots
         (work_conversation_ref, status, phase_summary, incomplete_tasks_json, risks_json,
          pending_confirmations_json, deadlines_json, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_conversation_ref) DO UPDATE SET
           status = excluded.status,
           phase_summary = excluded.phase_summary,
           incomplete_tasks_json = excluded.incomplete_tasks_json,
           risks_json = excluded.risks_json,
           pending_confirmations_json = excluded.pending_confirmations_json,
           deadlines_json = excluded.deadlines_json,
           updated_at = excluded.updated_at`
      ).run(
        input.snapshot.workConversationRef,
        input.snapshot.status,
        input.snapshot.phaseSummary,
        JSON.stringify(input.snapshot.incompleteTasks),
        JSON.stringify(input.snapshot.risks),
        JSON.stringify(input.snapshot.pendingConfirmations),
        JSON.stringify(input.snapshot.deadlines),
        input.snapshot.updatedAt
      );
      const snapshot = this.getWorkProgressSnapshot(
        input.personRef,
        input.snapshot.workConversationRef
      );
      if (!snapshot) throw new Error("Work progress snapshot was not readable after save");
      return snapshot;
    });
    return save();
  }

  getWorkProgressSnapshot(
    personRef: string,
    workConversationRef: string
  ): WorkProgressSnapshot | null {
    const read = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT p.work_conversation_ref, p.status, p.phase_summary, w.agent_ref,
                p.incomplete_tasks_json, p.risks_json, p.pending_confirmations_json,
                p.deadlines_json, p.updated_at
         FROM work_progress_snapshots p
         JOIN work_conversations w
           ON w.work_conversation_ref = p.work_conversation_ref
          AND w.entry_audience = 'personal'
         JOIN interaction_threads t
           ON t.thread_ref = w.thread_ref
          AND t.person_ref = w.person_ref
          AND t.agent_ref = w.agent_ref
          AND t.entry_audience = w.entry_audience
          AND t.thread_kind = 'work'
         WHERE p.work_conversation_ref = ? AND w.person_ref = ?`
      ).get(workConversationRef, personRef) as Record<string, unknown> | undefined;
      if (!row) return null;
      this.agentManagement.requireActiveMount(personRef, String(row.agent_ref));
      return mapWorkProgressSnapshot(row);
    });
    return read();
  }

  getAdminWorkProgressSnapshot(input: {
    context: ThreadAccessContext;
    workConversationRef: string;
  }): WorkProgressSnapshot | null {
    this.requireAdminContext(input.context);
    const row = this.db.prepare(
      `SELECT p.work_conversation_ref, p.status, p.phase_summary,
              p.incomplete_tasks_json, p.risks_json, p.pending_confirmations_json,
              p.deadlines_json, p.updated_at
       FROM work_progress_snapshots p
       JOIN work_conversations w
         ON w.work_conversation_ref = p.work_conversation_ref
        AND w.entry_audience = 'family_admin'
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.agent_ref = w.agent_ref
        AND t.entry_audience = w.entry_audience
        AND t.thread_kind = 'work'
       WHERE p.work_conversation_ref = ? AND t.family_ref = ?
         AND w.person_ref = ? AND w.agent_ref = ?`
    ).get(
      input.workConversationRef,
      input.context.familyRef,
      input.context.personRef,
      input.context.agentRef
    ) as Record<string, unknown> | undefined;
    return row ? mapWorkProgressSnapshot(row) : null;
  }

  resolveAdminWorkAgent(input: {
    familyRef: string;
    personRef: string;
    workConversationRef: string;
  }): string {
    const row = this.db.prepare(
      `SELECT w.agent_ref
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.agent_ref = w.agent_ref
        AND t.entry_audience = w.entry_audience
        AND t.thread_kind = 'work'
       WHERE w.work_conversation_ref = ? AND t.family_ref = ?
         AND w.person_ref = ? AND w.entry_audience = 'family_admin'`
    ).get(
      input.workConversationRef,
      input.familyRef,
      input.personRef
    ) as { agent_ref: string } | undefined;
    if (!row) throw workNotFound();
    const agentRef = String(row.agent_ref);
    requireAdminAgentAssignment(this.db, {
      familyRef: input.familyRef,
      personRef: input.personRef,
      agentRef
    });
    return agentRef;
  }

  resolveThreadAgent(input: {
    personRef: string;
    familyRef?: string | null;
    entryAudience: "personal" | "family_admin";
    threadRef: string;
  }): string {
    const row = this.db.prepare(
      `SELECT family_ref, agent_ref FROM interaction_threads
       WHERE thread_ref = ? AND person_ref = ? AND entry_audience = ?`
    ).get(input.threadRef, input.personRef, input.entryAudience) as
      | { family_ref: string | null; agent_ref: string }
      | undefined;
    if (!row) throw threadNotFound();
    const agentRef = String(row.agent_ref);
    if (input.entryAudience === "personal") {
      this.agentManagement.requireActiveMount(input.personRef, agentRef);
    } else {
      if (!input.familyRef || row.family_ref !== input.familyRef) throw threadNotFound();
      requireAdminAgentAssignment(this.db, {
        familyRef: input.familyRef,
        personRef: input.personRef,
        agentRef
      });
    }
    return agentRef;
  }

  requireThread(input: {
    personRef: string;
    familyRef?: string | null;
    agentRef: string;
    entryAudience: "personal" | "family_admin";
    threadRef: string;
  }): void {
    if (input.entryAudience === "personal") {
      this.agentManagement.requireActiveMount(input.personRef, input.agentRef);
    } else {
      if (!input.familyRef) throw threadNotFound();
      requireAdminAgentAssignment(this.db, {
        familyRef: input.familyRef,
        personRef: input.personRef,
        agentRef: input.agentRef
      });
    }
    const row = this.db.prepare(
      `SELECT 1 FROM interaction_threads
       WHERE thread_ref = ? AND person_ref = ? AND agent_ref = ? AND entry_audience = ?
         AND family_ref IS ?`
    ).get(
      input.threadRef,
      input.personRef,
      input.agentRef,
      input.entryAudience,
      input.entryAudience === "personal" ? null : input.familyRef
    );
    if (!row) throw threadNotFound();
  }

  private requireAdminContext(context: ThreadAccessContext): void {
    if (context.entryAudience !== "family_admin" || !context.familyRef) {
      throw threadNotFound();
    }
    requireAdminAgentAssignment(this.db, {
      familyRef: context.familyRef,
      personRef: context.personRef,
      agentRef: context.agentRef
    });
  }

  private adminWorkRow(
    context: ThreadAccessContext,
    workConversationRef: string
  ): Record<string, unknown> | null {
    const row = this.db.prepare(
      `SELECT t.thread_ref, t.person_ref, t.agent_ref, t.last_sequence,
              t.created_at, t.last_active_at,
              w.work_conversation_ref, w.title, w.goal, w.summary, w.status, w.archived_at
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.agent_ref = w.agent_ref
        AND t.entry_audience = w.entry_audience
        AND t.thread_kind = 'work'
       WHERE w.work_conversation_ref = ? AND t.family_ref = ?
         AND w.person_ref = ? AND w.agent_ref = ?
         AND w.entry_audience = 'family_admin'`
    ).get(
      workConversationRef,
      context.familyRef,
      context.personRef,
      context.agentRef
    ) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  private validateMessageProvenance(
    personRef: string,
    actor: ThreadActor,
    origin: ThreadMessageOrigin
  ): void {
    switch (actor.type) {
      case "person": {
        if (actor.personRef !== personRef || !origin.deviceRef) {
          throw messageInvalid("Person 消息的成员或设备来源无效。");
        }
        const binding = this.db.prepare(
          `SELECT 1
           FROM managed_devices d
           JOIN device_bindings b
             ON b.device_ref = d.device_ref
            AND b.status = 'active'
           LEFT JOIN family_memberships fm
             ON fm.family_ref = b.family_ref
            AND fm.person_ref = ?
            AND fm.status = 'active'
           WHERE d.device_ref = ?
             AND d.status = 'active'
             AND (
               (b.owner_scope = 'person' AND b.person_ref = ?) OR
               (b.owner_scope = 'family' AND fm.person_ref IS NOT NULL)
             )
           LIMIT 1`
        ).get(personRef, origin.deviceRef, personRef);
        if (!binding) {
          throw messageInvalid("这个设备不能代表当前家庭成员发送消息。");
        }
        return;
      }
      case "assistant": {
        const assignment = this.db.prepare(
          `SELECT 1 FROM assistant_assignments
           WHERE assignment_ref = ?
             AND person_ref = ?
             AND agent_ref = ?
             AND provider_profile_ref = ?
             AND status = 'active'`
        ).get(
          actor.assignmentRef,
          personRef,
          actor.agentRef,
          actor.providerProfileRef
        );
        if (!assignment) {
          throw messageInvalid("Assistant 消息的 Assignment 来源无效。");
        }
        return;
      }
      case "system":
        if (origin.entryAudience !== "system") {
          throw messageInvalid("System 消息必须使用 system audience。");
        }
        return;
      case "agent":
        return;
    }
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
    agentRef: string;
    title: string;
    goal: string;
    now: string;
  }): WorkConversation {
    const threadRef = `thread:${randomUUID()}`;
    const workConversationRef = `work:${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO interaction_threads
       (thread_ref, person_ref, family_ref, agent_ref, entry_audience,
        thread_kind, last_sequence, created_at, last_active_at)
       VALUES(?, ?, NULL, ?, 'personal', 'work', 0, ?, ?)`
    ).run(threadRef, input.personRef, input.agentRef, input.now, input.now);
    this.db.prepare(
      `INSERT INTO work_conversations
       (work_conversation_ref, thread_ref, person_ref, agent_ref, entry_audience,
        title, goal, summary, status, archived_at)
       VALUES(?, ?, ?, ?, 'personal', ?, ?, '', 'active', NULL)`
    ).run(
      workConversationRef,
      threadRef,
      input.personRef,
      input.agentRef,
      input.title,
      input.goal
    );

    const work = this.getWorkConversation(
      input.personRef,
      input.agentRef,
      workConversationRef
    );
    if (!work) throw new Error("Work Conversation was not readable after creation");
    return work;
  }

  private resolveWorkAgent(
    personRef: string,
    workConversationRef: string
  ): string | null {
    const row = this.db.prepare(
      `SELECT w.agent_ref
       FROM work_conversations w
       JOIN interaction_threads t
         ON t.thread_ref = w.thread_ref
        AND t.person_ref = w.person_ref
        AND t.agent_ref = w.agent_ref
        AND t.entry_audience = w.entry_audience
        AND t.thread_kind = 'work'
       WHERE w.work_conversation_ref = ? AND w.person_ref = ?
         AND w.entry_audience = 'personal'`
    ).get(workConversationRef, personRef) as { agent_ref: string } | undefined;
    if (!row) return null;
    const agentRef = String(row.agent_ref);
    this.agentManagement.requireActiveMount(personRef, agentRef);
    return agentRef;
  }
}
