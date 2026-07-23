import { randomUUID } from "node:crypto";
import type {
  PublicError,
  TextPayload,
  ThreadMessage
} from "@family-ai/contracts";
import { sha256, type GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

export interface ThreadProviderContext {
  threadRef: string;
  personRef: string;
  providerConversationRef: string;
  assignmentRef: string;
  agentRef: string;
  providerProfileRef: string;
  externalSessionRef: string | null;
}

export interface PreparedProviderTurn {
  userMessageRef: string;
  threadRef: string;
  invocationRef: string;
  correlationRef: string;
  idempotencyKey: string;
  assignmentRef: string;
  agentRef: string;
  providerProfileRef: string;
  providerConversationRef: string;
  externalSessionRef: string | null;
  requestedAt: string;
  status: "pending" | "succeeded";
  attemptCount: number;
  assistantMessageRef: string | null;
}

interface ActiveAssignment {
  assignmentRef: string;
  agentRef: string;
  providerProfileRef: string;
}

interface StoredTurnRow extends Record<string, unknown> {
  user_message_ref: string;
  thread_ref: string;
  invocation_ref: string;
  correlation_ref: string;
  idempotency_key: string;
  assignment_ref: string;
  agent_ref: string;
  provider_profile_ref: string;
  status: "pending" | "succeeded" | "failed";
  attempt_count: number;
  assistant_message_ref: string | null;
  requested_at: string;
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

function assignmentUnavailable(): GatewayDomainError {
  return new GatewayDomainError(
    "ASSISTANT_ASSIGNMENT_UNAVAILABLE",
    503,
    "availability",
    true,
    "当前个人助理暂时不可用。"
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
    assignmentRef: String(row.assignment_ref),
    agentRef: String(row.agent_ref),
    providerProfileRef: String(row.provider_profile_ref),
    externalSessionRef: nullableString(row.external_session_ref)
  };
}

function mapPreparedTurn(
  row: StoredTurnRow,
  context: ThreadProviderContext
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
    assignmentRef: String(row.assignment_ref),
    agentRef: String(row.agent_ref),
    providerProfileRef: String(row.provider_profile_ref),
    providerConversationRef: context.providerConversationRef,
    externalSessionRef: context.externalSessionRef,
    requestedAt: String(row.requested_at),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    assistantMessageRef: nullableString(row.assistant_message_ref)
  };
}

export class ChatWorkProviderRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  resolveContext(personRef: string, threadRef: string): ThreadProviderContext {
    const resolve = this.db.transaction(() => {
      const thread = this.db.prepare(
        `SELECT person_ref FROM interaction_threads
         WHERE thread_ref = ? AND person_ref = ?`
      ).get(threadRef, personRef);
      if (!thread) throw threadNotFound();

      const assignmentRow = this.db.prepare(
        `SELECT assignment_ref, agent_ref, provider_profile_ref
         FROM assistant_assignments
         WHERE person_ref = ? AND status = 'active'`
      ).get(personRef) as Record<string, unknown> | undefined;
      if (!assignmentRow) throw assignmentUnavailable();
      const assignment: ActiveAssignment = {
        assignmentRef: String(assignmentRow.assignment_ref),
        agentRef: String(assignmentRow.agent_ref),
        providerProfileRef: String(assignmentRow.provider_profile_ref)
      };

      const existingRow = this.db.prepare(
        `SELECT thread_ref, person_ref, provider_conversation_ref,
                assignment_ref, agent_ref, provider_profile_ref,
                external_session_ref
         FROM thread_provider_contexts
         WHERE thread_ref = ? AND person_ref = ?`
      ).get(threadRef, personRef) as Record<string, unknown> | undefined;
      const timestamp = this.now().toISOString();

      if (!existingRow) {
        this.db.prepare(
          `INSERT INTO thread_provider_contexts
           (thread_ref, person_ref, provider_conversation_ref, assignment_ref,
            agent_ref, provider_profile_ref, external_session_ref, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        ).run(
          threadRef,
          personRef,
          `conversation:${randomUUID()}`,
          assignment.assignmentRef,
          assignment.agentRef,
          assignment.providerProfileRef,
          timestamp,
          timestamp
        );
      } else if (
        String(existingRow.assignment_ref) !== assignment.assignmentRef ||
        String(existingRow.agent_ref) !== assignment.agentRef ||
        String(existingRow.provider_profile_ref) !== assignment.providerProfileRef
      ) {
        this.db.prepare(
          `UPDATE thread_provider_contexts
           SET assignment_ref = ?, agent_ref = ?, provider_profile_ref = ?,
               external_session_ref = NULL, updated_at = ?
           WHERE thread_ref = ? AND person_ref = ?`
        ).run(
          assignment.assignmentRef,
          assignment.agentRef,
          assignment.providerProfileRef,
          timestamp,
          threadRef,
          personRef
        );
      }

      const contextRow = this.db.prepare(
        `SELECT thread_ref, person_ref, provider_conversation_ref,
                assignment_ref, agent_ref, provider_profile_ref,
                external_session_ref
         FROM thread_provider_contexts
         WHERE thread_ref = ? AND person_ref = ?`
      ).get(threadRef, personRef) as Record<string, unknown> | undefined;
      if (!contextRow) throw new Error("Thread Provider Context was not readable after resolution");
      return mapContext(contextRow);
    });

    return resolve();
  }

  prepareTurn(input: {
    personRef: string;
    userMessage: ThreadMessage;
  }): PreparedProviderTurn {
    const context = this.resolveContext(input.personRef, input.userMessage.threadRef);
    const prepare = this.db.transaction(() => {
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
        input.userMessage.messageRef,
        input.userMessage.threadRef,
        input.personRef,
        input.personRef
      );
      if (!message) throw threadNotFound();

      const existing = this.db.prepare(
        `SELECT user_message_ref, thread_ref, invocation_ref, correlation_ref,
                idempotency_key, assignment_ref, agent_ref, provider_profile_ref,
                status, attempt_count, assistant_message_ref, requested_at
         FROM thread_provider_turns
         WHERE user_message_ref = ?`
      ).get(input.userMessage.messageRef) as StoredTurnRow | undefined;

      if (existing?.status === "succeeded") {
        return mapPreparedTurn(existing, context);
      }

      if (existing) {
        this.db.prepare(
          `UPDATE thread_provider_turns
           SET status = 'pending', attempt_count = attempt_count + 1,
               assistant_message_ref = NULL, error_json = NULL, completed_at = NULL
           WHERE user_message_ref = ? AND status <> 'succeeded'`
        ).run(input.userMessage.messageRef);
      } else {
        const requestedAt = this.now().toISOString();
        const invocationRef = `invocation:${randomUUID()}`;
        const correlationRef = `correlation:${randomUUID()}`;
        const idempotencyKey = `thread-turn:${sha256(
          `${input.userMessage.threadRef}:${input.userMessage.messageRef}:` +
          `${context.assignmentRef}:${context.providerProfileRef}`
        ).slice(0, 48)}`;
        this.db.prepare(
          `INSERT INTO thread_provider_turns
           (user_message_ref, thread_ref, invocation_ref, correlation_ref, idempotency_key,
            assignment_ref, agent_ref, provider_profile_ref, status, attempt_count,
            assistant_message_ref, error_json, requested_at, completed_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, NULL, NULL, ?, NULL)`
        ).run(
          input.userMessage.messageRef,
          input.userMessage.threadRef,
          invocationRef,
          correlationRef,
          idempotencyKey,
          context.assignmentRef,
          context.agentRef,
          context.providerProfileRef,
          requestedAt
        );
      }

      const preparedRow = this.db.prepare(
        `SELECT user_message_ref, thread_ref, invocation_ref, correlation_ref,
                idempotency_key, assignment_ref, agent_ref, provider_profile_ref,
                status, attempt_count, assistant_message_ref, requested_at
         FROM thread_provider_turns
         WHERE user_message_ref = ?`
      ).get(input.userMessage.messageRef) as StoredTurnRow | undefined;
      if (!preparedRow || preparedRow.status !== "pending") {
        throw new Error("Provider Turn was not pending after preparation");
      }
      return mapPreparedTurn(preparedRow, context);
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

  commitTurnSucceeded(input: {
    personRef: string;
    userMessage: ThreadMessage;
    turn: PreparedProviderTurn;
    output: TextPayload;
    externalSessionRef: string;
    completedAt: string;
  }): string {
    const commit = this.db.transaction(() => {
      const storedTurn = this.db.prepare(
        `SELECT user_message_ref, thread_ref, invocation_ref, correlation_ref,
                idempotency_key, assignment_ref, agent_ref, provider_profile_ref,
                status, attempt_count, assistant_message_ref, requested_at
         FROM thread_provider_turns
         WHERE user_message_ref = ? AND thread_ref = ?`
      ).get(
        input.userMessage.messageRef,
        input.userMessage.threadRef
      ) as StoredTurnRow | undefined;
      if (!storedTurn) throw providerTurnNotFound();
      if (storedTurn.status === "succeeded" && storedTurn.assistant_message_ref) {
        return String(storedTurn.assistant_message_ref);
      }
      if (storedTurn.status !== "pending") {
        throw new Error(`Provider Turn cannot succeed from status ${storedTurn.status}`);
      }
      if (
        storedTurn.invocation_ref !== input.turn.invocationRef ||
        storedTurn.correlation_ref !== input.turn.correlationRef ||
        storedTurn.assignment_ref !== input.turn.assignmentRef ||
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

      this.db.prepare(
        `UPDATE daily_episodes
         SET last_message_sequence = ?
         WHERE thread_ref = ? AND archive_status = 'open'`
      ).run(sequence.last_sequence, input.userMessage.threadRef);

      this.db.prepare(
        `UPDATE thread_provider_contexts
         SET external_session_ref = ?, updated_at = ?
         WHERE thread_ref = ? AND person_ref = ?
           AND assignment_ref = ? AND agent_ref = ? AND provider_profile_ref = ?`
      ).run(
        input.externalSessionRef,
        input.completedAt,
        input.userMessage.threadRef,
        input.personRef,
        storedTurn.assignment_ref,
        storedTurn.agent_ref,
        storedTurn.provider_profile_ref
      );

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
}
