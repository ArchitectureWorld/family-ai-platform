import { randomUUID } from "node:crypto";
import type {
  PublicError,
  TextPayload,
  ThreadMessage
} from "@family-ai/contracts";
import { AgentManagementRepository } from "./agentManagement.js";
import { requireAdminAgentAssignment } from "./adminWorkspace.js";
import type { ThreadAccessContext } from "./chatWorkDomain.js";
import { sha256, type GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

export interface ThreadProviderContext {
  threadRef: string;
  personRef: string;
  providerConversationRef: string;
  assignmentRef: string | null;
  agentRef: string;
  providerProfileRef: string;
  entryAudience: "personal" | "family_admin";
  externalSessionRef: string | null;
}

export interface PreparedProviderTurn {
  userMessageRef: string;
  threadRef: string;
  invocationRef: string;
  correlationRef: string;
  idempotencyKey: string;
  assignmentRef: string | null;
  agentRef: string;
  providerProfileRef: string;
  entryAudience: "personal" | "family_admin";
  providerConversationRef: string;
  externalSessionRef: string | null;
  requestedAt: string;
  status: "pending" | "succeeded";
  attemptCount: number;
  assistantMessageRef: string | null;
  rebuildProviderContext: boolean;
}

export interface AgentProviderTurnFacts {
  pending: number;
  stalePending: number;
  latestFailedAt: string | null;
  latestSucceededAt: string | null;
}

interface ActiveAssignment {
  assignmentRef: string | null;
  agentRef: string;
  providerProfileRef: string;
}

interface StoredTurnRow extends Record<string, unknown> {
  user_message_ref: string;
  thread_ref: string;
  invocation_ref: string;
  correlation_ref: string;
  idempotency_key: string;
  assignment_ref: string | null;
  agent_ref: string;
  provider_profile_ref: string;
  entry_audience: "personal" | "family_admin";
  status: "pending" | "succeeded" | "failed";
  attempt_count: number;
  assistant_message_ref: string | null;
  requested_at: string;
  error_json: string | null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
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

function providerTurnNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "PROVIDER_TURN_NOT_FOUND",
    404,
    "internal",
    false,
    "没有找到对应的 Provider Turn。"
  );
}

function mapContext(row: Record<string, unknown>): ThreadProviderContext {
  return {
    threadRef: String(row.thread_ref),
    personRef: String(row.person_ref),
    providerConversationRef: String(row.provider_conversation_ref),
    assignmentRef: nullableString(row.assignment_ref),
    agentRef: String(row.agent_ref),
    providerProfileRef: String(row.provider_profile_ref),
    entryAudience: row.entry_audience as "personal" | "family_admin",
    externalSessionRef: nullableString(row.external_session_ref)
  };
}

function mapPreparedTurn(
  row: StoredTurnRow,
  context: ThreadProviderContext,
  rebuildProviderContext = false
): PreparedProviderTurn {
  if (row.status === "failed") {
    throw new Error("Failed Provider Turn must be reset before mapping");
  }
  return {
    userMessageRef: String(row.user_message_ref),
    threadRef: String(row.thread_ref),
    invocationRef: String(row.invocation_ref),
    correlationRef: String(row.correlation_ref),
    idempotencyKey: String(row.idempotency_key),
    assignmentRef: nullableString(row.assignment_ref),
    agentRef: String(row.agent_ref),
    providerProfileRef: String(row.provider_profile_ref),
    entryAudience: row.entry_audience,
    providerConversationRef: context.providerConversationRef,
    externalSessionRef: context.externalSessionRef,
    requestedAt: String(row.requested_at),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    assistantMessageRef: nullableString(row.assistant_message_ref),
    rebuildProviderContext
  };
}

function newTurnIdentity(
  userMessage: ThreadMessage,
  context: ThreadProviderContext,
  requestedAt: string
) {
  return {
    invocationRef: `invocation:${randomUUID()}`,
    correlationRef: `correlation:${randomUUID()}`,
    idempotencyKey: `thread-turn:${sha256(
      `${userMessage.threadRef}:${userMessage.messageRef}:` +
      `${context.agentRef}:${context.providerProfileRef}`
    ).slice(0, 48)}`,
    requestedAt
  };
}

export class ChatWorkProviderRepository {
  private readonly agentManagement: AgentManagementRepository;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date(),
    agentManagement?: AgentManagementRepository
  ) {
    this.agentManagement = agentManagement ?? new AgentManagementRepository(db, now);
  }

  resolveContext(
    personRefOrContext: string | ThreadAccessContext,
    threadRef: string
  ): ThreadProviderContext {
    const resolve = this.db.transaction(() => {
      const personRef = typeof personRefOrContext === "string"
        ? personRefOrContext
        : personRefOrContext.personRef;
      const thread = this.db.prepare(
        `SELECT person_ref, family_ref, agent_ref, entry_audience FROM interaction_threads
         WHERE thread_ref = ? AND person_ref = ?`
      ).get(threadRef, personRef) as
        | {
            person_ref: string;
            family_ref: string | null;
            agent_ref: string;
            entry_audience: "personal" | "family_admin";
          }
        | undefined;
      if (!thread) throw threadNotFound();
      if (typeof personRefOrContext !== "string") {
        if (
          thread.family_ref !== personRefOrContext.familyRef ||
          thread.entry_audience !== personRefOrContext.entryAudience ||
          thread.agent_ref !== personRefOrContext.agentRef
        ) {
          throw threadNotFound();
        }
      } else if (thread.entry_audience !== "personal") {
        throw threadNotFound();
      }
      const assignment: ActiveAssignment = thread.entry_audience === "personal"
        ? (() => {
            const row = this.agentManagement.requireActiveMount(
              personRef,
              String(thread.agent_ref)
            );
            return {
              assignmentRef: row.assignmentRef,
              agentRef: row.agentRef,
              providerProfileRef: row.providerProfileRef
            };
          })()
        : (() => {
            if (!thread.family_ref) throw threadNotFound();
            const row = requireAdminAgentAssignment(this.db, {
              familyRef: thread.family_ref,
              personRef,
              agentRef: String(thread.agent_ref)
            });
            return {
              assignmentRef: null,
              agentRef: row.agentRef,
              providerProfileRef: row.providerProfileRef
            };
          })();

      const existingRow = this.readContext(personRef, threadRef);
      const timestamp = this.now().toISOString();

      if (!existingRow) {
        this.db.prepare(
          `INSERT INTO thread_provider_contexts
           (thread_ref, person_ref, provider_conversation_ref, assignment_ref,
            agent_ref, provider_profile_ref, entry_audience,
            external_session_ref, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        ).run(
          threadRef,
          personRef,
          `conversation:${randomUUID()}`,
          assignment.assignmentRef,
          assignment.agentRef,
          assignment.providerProfileRef,
          thread.entry_audience,
          timestamp,
          timestamp
        );
      } else if (
        existingRow.agentRef === assignment.agentRef &&
        existingRow.providerProfileRef === assignment.providerProfileRef &&
        existingRow.assignmentRef !== assignment.assignmentRef
      ) {
        this.db.prepare(
          `UPDATE thread_provider_contexts
           SET assignment_ref = ?, updated_at = ?
           WHERE thread_ref = ? AND person_ref = ? AND entry_audience = ?`
        ).run(
          assignment.assignmentRef,
          timestamp,
          threadRef,
          personRef,
          thread.entry_audience
        );
      } else if (
        existingRow.agentRef !== assignment.agentRef ||
        existingRow.providerProfileRef !== assignment.providerProfileRef
      ) {
        this.db.prepare(
          `UPDATE thread_provider_contexts
           SET assignment_ref = ?, agent_ref = ?, provider_profile_ref = ?,
               entry_audience = ?,
               external_session_ref = NULL, updated_at = ?
           WHERE thread_ref = ? AND person_ref = ? AND entry_audience = ?`
        ).run(
          assignment.assignmentRef,
          assignment.agentRef,
          assignment.providerProfileRef,
          thread.entry_audience,
          timestamp,
          threadRef,
          personRef,
          thread.entry_audience
        );
      }

      const context = this.readContext(personRef, threadRef);
      if (!context) throw new Error("Thread Provider Context was not readable after resolution");
      return context;
    });

    return resolve();
  }

  statusFacts(agentRef: string, staleBefore: string): AgentProviderTurnFacts {
    const row = this.db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'pending' AND requested_at < ? THEN 1 ELSE 0 END)
           AS stale_pending,
         MAX(CASE WHEN status = 'failed' THEN completed_at END) AS latest_failed_at,
         MAX(CASE WHEN status = 'succeeded' THEN completed_at END) AS latest_succeeded_at
       FROM thread_provider_turns
       WHERE agent_ref = ?`
    ).get(staleBefore, agentRef) as Record<string, unknown>;
    return {
      pending: Number(row.pending ?? 0),
      stalePending: Number(row.stale_pending ?? 0),
      latestFailedAt: row.latest_failed_at === null
        ? null
        : String(row.latest_failed_at),
      latestSucceededAt: row.latest_succeeded_at === null
        ? null
        : String(row.latest_succeeded_at)
    };
  }

  prepareTurn(input: {
    personRef: string;
    accessContext?: ThreadAccessContext;
    userMessage: ThreadMessage;
  }): PreparedProviderTurn {
    const access = input.accessContext ?? input.personRef;
    this.requirePersonMessage(input.personRef, input.userMessage);

    const immediate = this.readTurn(input.userMessage.messageRef);
    if (immediate?.status === "succeeded") {
      this.resolveContext(access, input.userMessage.threadRef);
      const storedContext = this.readContext(input.personRef, input.userMessage.threadRef);
      if (!storedContext) {
        throw new Error("Successful Provider Turn has no stored Thread Context");
      }
      return mapPreparedTurn(immediate, storedContext);
    }

    const context = this.resolveContext(access, input.userMessage.threadRef);
    const prepare = this.db.transaction(() => {
      this.requirePersonMessage(input.personRef, input.userMessage);
      if (context.entryAudience === "personal") {
        this.agentManagement.requireActiveMount(input.personRef, context.agentRef);
      } else if (!input.accessContext?.familyRef) {
        throw threadNotFound();
      } else {
        requireAdminAgentAssignment(this.db, {
          familyRef: input.accessContext.familyRef,
          personRef: input.personRef,
          agentRef: context.agentRef
        });
      }
      const existing = this.readTurn(input.userMessage.messageRef);

      if (existing?.status === "succeeded") {
        const storedContext = this.readContext(input.personRef, input.userMessage.threadRef);
        if (!storedContext) {
          throw new Error("Successful Provider Turn has no stored Thread Context");
        }
        return mapPreparedTurn(existing, storedContext);
      }

      if (existing) {
        const contextChanged =
          nullableString(existing.assignment_ref) !== context.assignmentRef ||
          String(existing.agent_ref) !== context.agentRef ||
          String(existing.provider_profile_ref) !== context.providerProfileRef;

        if (contextChanged) {
          const identity = newTurnIdentity(
            input.userMessage,
            context,
            this.now().toISOString()
          );
          this.db.prepare(
            `UPDATE thread_provider_turns
             SET invocation_ref = ?, correlation_ref = ?, idempotency_key = ?,
                 assignment_ref = ?, agent_ref = ?, provider_profile_ref = ?,
                 entry_audience = ?,
                 status = 'pending', attempt_count = attempt_count + 1,
                 assistant_message_ref = NULL, error_json = NULL,
                 requested_at = ?, completed_at = NULL
             WHERE user_message_ref = ? AND status <> 'succeeded'`
          ).run(
            identity.invocationRef,
            identity.correlationRef,
            identity.idempotencyKey,
            context.assignmentRef,
            context.agentRef,
            context.providerProfileRef,
            context.entryAudience,
            identity.requestedAt,
            input.userMessage.messageRef
          );
        } else {
          this.db.prepare(
            `UPDATE thread_provider_turns
             SET status = 'pending', attempt_count = attempt_count + 1,
                 assistant_message_ref = NULL, error_json = NULL, completed_at = NULL
             WHERE user_message_ref = ? AND status <> 'succeeded'`
          ).run(input.userMessage.messageRef);
        }
      } else {
        const identity = newTurnIdentity(
          input.userMessage,
          context,
          this.now().toISOString()
        );
        this.db.prepare(
          `INSERT INTO thread_provider_turns
           (user_message_ref, thread_ref, invocation_ref, correlation_ref, idempotency_key,
            assignment_ref, agent_ref, provider_profile_ref, status, attempt_count,
            entry_audience, assistant_message_ref, error_json, requested_at, completed_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, NULL, NULL, ?, NULL)`
        ).run(
          input.userMessage.messageRef,
          input.userMessage.threadRef,
          identity.invocationRef,
          identity.correlationRef,
          identity.idempotencyKey,
          context.assignmentRef,
          context.agentRef,
          context.providerProfileRef,
          context.entryAudience,
          identity.requestedAt
        );
      }

      const preparedRow = this.readTurn(input.userMessage.messageRef);
      if (!preparedRow || preparedRow.status !== "pending") {
        throw new Error("Provider Turn was not pending after preparation");
      }
      const rebuildProviderContext = existing?.status === "failed" &&
        this.storedErrorCode(existing.error_json) === "PROVIDER_SESSION_NOT_FOUND";
      return mapPreparedTurn(preparedRow, context, rebuildProviderContext);
    });

    return prepare();
  }

  markTurnFailed(input: {
    userMessageRef: string;
    error: PublicError;
    completedAt: string;
  }): void {
    const result = this.db.prepare(
      `UPDATE thread_provider_turns
       SET status = 'failed', assistant_message_ref = NULL,
           error_json = ?, completed_at = ?
       WHERE user_message_ref = ? AND status = 'pending'`
    ).run(JSON.stringify(input.error), input.completedAt, input.userMessageRef);
    if (result.changes === 0) {
      const existing = this.db.prepare(
        "SELECT status FROM thread_provider_turns WHERE user_message_ref = ?"
      ).get(input.userMessageRef) as { status: string } | undefined;
      if (!existing) throw providerTurnNotFound();
      if (existing.status !== "succeeded") {
        throw new Error(`Provider Turn could not be failed from status ${existing.status}`);
      }
    }
  }

  clearMissingExternalSession(input: {
    turn: PreparedProviderTurn;
    completedAt: string;
  }): void {
    if (!input.turn.externalSessionRef) return;
    this.db.prepare(
      `UPDATE thread_provider_contexts
       SET external_session_ref = NULL, updated_at = ?
       WHERE thread_ref = ? AND person_ref = ?
         AND agent_ref = ? AND provider_profile_ref = ?
         AND external_session_ref = ?`
    ).run(
      input.completedAt,
      input.turn.threadRef,
      this.personRefForThread(input.turn.threadRef),
      input.turn.agentRef,
      input.turn.providerProfileRef,
      input.turn.externalSessionRef
    );
  }

  commitTurnSucceeded(input: {
    personRef: string;
    userMessage: ThreadMessage;
    turn: PreparedProviderTurn;
    output: TextPayload;
    externalSessionRef: string;
    completedAt: string;
  }): string {
    const commit = this.db.transaction(() => {
      const storedTurn = this.readTurn(input.userMessage.messageRef);
      if (!storedTurn || String(storedTurn.thread_ref) !== input.userMessage.threadRef) {
        throw providerTurnNotFound();
      }
      if (storedTurn.status === "succeeded" && storedTurn.assistant_message_ref) {
        return String(storedTurn.assistant_message_ref);
      }
      if (storedTurn.status !== "pending") {
        throw new Error(`Provider Turn cannot succeed from status ${storedTurn.status}`);
      }
      if (
        storedTurn.invocation_ref !== input.turn.invocationRef ||
        storedTurn.correlation_ref !== input.turn.correlationRef ||
        nullableString(storedTurn.assignment_ref) !== input.turn.assignmentRef ||
        storedTurn.agent_ref !== input.turn.agentRef ||
        storedTurn.provider_profile_ref !== input.turn.providerProfileRef
      ) {
        throw new Error("Provider Turn facts changed before success commit");
      }

      const sequence = this.db.prepare(
        `UPDATE interaction_threads
         SET last_sequence = last_sequence + 1, last_active_at = ?
         WHERE thread_ref = ? AND person_ref = ?
         RETURNING last_sequence`
      ).get(
        input.completedAt,
        input.userMessage.threadRef,
        input.personRef
      ) as { last_sequence: number } | undefined;
      if (!sequence) throw threadNotFound();

      const assistantMessageRef = `message:${randomUUID()}`;
      const createdAt = this.now().toISOString();
      if (input.turn.entryAudience === "personal") {
        this.db.prepare(
          `INSERT INTO thread_messages
         (message_ref, thread_ref, thread_sequence, client_message_id,
          actor_type, actor_person_ref, actor_assignment_ref, actor_agent_ref,
          actor_provider_profile_ref, actor_system_ref,
          origin_device_ref, origin_connection_ref, entry_audience,
          content_type, content_text, content_language, occurred_at, created_at)
           VALUES(?, ?, ?, ?, 'assistant', NULL, ?, ?, ?, NULL,
                NULL, NULL, 'personal', 'text', ?, ?, ?, ?)`
        ).run(
          assistantMessageRef,
          input.userMessage.threadRef,
          sequence.last_sequence,
          `assistant:${input.userMessage.messageRef}`,
          storedTurn.assignment_ref,
          storedTurn.agent_ref,
          storedTurn.provider_profile_ref,
          input.output.text,
          input.output.language ?? null,
          input.completedAt,
          createdAt
        );
      } else {
        this.db.prepare(
          `INSERT INTO thread_messages
           (message_ref, thread_ref, thread_sequence, client_message_id,
            actor_type, actor_person_ref, actor_assignment_ref, actor_agent_ref,
            actor_provider_profile_ref, actor_system_ref,
            origin_device_ref, origin_connection_ref, entry_audience,
            content_type, content_text, content_language, occurred_at, created_at)
           VALUES(?, ?, ?, ?, 'agent', NULL, NULL, ?, ?, NULL,
                  NULL, NULL, 'family_admin', 'text', ?, ?, ?, ?)`
        ).run(
          assistantMessageRef,
          input.userMessage.threadRef,
          sequence.last_sequence,
          `agent:${input.userMessage.messageRef}`,
          storedTurn.agent_ref,
          storedTurn.provider_profile_ref,
          input.output.text,
          input.output.language ?? null,
          input.completedAt,
          createdAt
        );
      }

      this.db.prepare(
        `UPDATE daily_episodes
         SET last_message_sequence = ?
         WHERE thread_ref = ? AND archive_status = 'open'`
      ).run(sequence.last_sequence, input.userMessage.threadRef);

      const contextUpdated = this.db.prepare(
        `UPDATE thread_provider_contexts
         SET external_session_ref = ?, updated_at = ?
         WHERE thread_ref = ? AND person_ref = ?
           AND assignment_ref IS ? AND agent_ref = ? AND provider_profile_ref = ?
           AND entry_audience = ?`
      ).run(
        input.externalSessionRef,
        input.completedAt,
        input.userMessage.threadRef,
        input.personRef,
        storedTurn.assignment_ref,
        storedTurn.agent_ref,
        storedTurn.provider_profile_ref,
        input.turn.entryAudience
      );
      if (contextUpdated.changes !== 1) {
        throw new Error("Thread Provider Context changed before success commit");
      }

      const updated = this.db.prepare(
        `UPDATE thread_provider_turns
         SET status = 'succeeded', assistant_message_ref = ?,
             error_json = NULL, completed_at = ?
         WHERE user_message_ref = ? AND status = 'pending'`
      ).run(
        assistantMessageRef,
        input.completedAt,
        input.userMessage.messageRef
      );
      if (updated.changes !== 1) {
        throw new Error("Provider Turn was not marked succeeded");
      }

      return assistantMessageRef;
    });

    return commit();
  }

  private requirePersonMessage(personRef: string, userMessage: ThreadMessage): void {
    const message = this.db.prepare(
      `SELECT 1
       FROM thread_messages m
       JOIN interaction_threads t ON t.thread_ref = m.thread_ref
       WHERE m.message_ref = ?
         AND m.thread_ref = ?
         AND m.actor_type = 'person'
         AND m.actor_person_ref = ?
         AND t.person_ref = ?`
    ).get(
      userMessage.messageRef,
      userMessage.threadRef,
      personRef,
      personRef
    );
    if (!message) throw threadNotFound();
  }

  private readContext(personRef: string, threadRef: string): ThreadProviderContext | null {
    const row = this.db.prepare(
      `SELECT thread_ref, person_ref, provider_conversation_ref,
              assignment_ref, agent_ref, provider_profile_ref, entry_audience,
              external_session_ref
       FROM thread_provider_contexts
      WHERE thread_ref = ? AND person_ref = ?`
    ).get(threadRef, personRef) as Record<string, unknown> | undefined;
    return row ? mapContext(row) : null;
  }

  private readTurn(userMessageRef: string): StoredTurnRow | null {
    const row = this.db.prepare(
      `SELECT user_message_ref, thread_ref, invocation_ref, correlation_ref,
              idempotency_key, assignment_ref, agent_ref, provider_profile_ref,
              entry_audience,
              status, attempt_count, assistant_message_ref, error_json, requested_at
       FROM thread_provider_turns
       WHERE user_message_ref = ?`
    ).get(userMessageRef) as StoredTurnRow | undefined;
    return row ?? null;
  }

  private storedErrorCode(errorJson: string | null): string | null {
    if (!errorJson) return null;
    try {
      const value = JSON.parse(errorJson) as { code?: unknown };
      return typeof value.code === "string" ? value.code : null;
    } catch {
      return null;
    }
  }

  private personRefForThread(threadRef: string): string {
    const row = this.db.prepare(
      "SELECT person_ref FROM interaction_threads WHERE thread_ref = ?"
    ).get(threadRef) as { person_ref: string } | undefined;
    if (!row) throw threadNotFound();
    return String(row.person_ref);
  }
}
