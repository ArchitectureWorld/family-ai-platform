import { describe, expect, it } from "vitest";
import {
  createOutgoingMessage,
  mergeThreadMessages,
  reconcileOutgoing,
  retryPayload
} from "../member-public/thread.js";

const personMessage = {
  messageRef: "message:person-0001",
  threadRef: "thread:chat-0001",
  threadSequence: 1,
  clientMessageId: "web:message-0001",
  actor: { type: "person", personRef: "person:alice" },
  origin: {
    deviceRef: "device:web-alice",
    connectionRef: null,
    entryAudience: "personal"
  },
  content: { type: "text", text: "第一条消息。", language: "zh-CN" },
  occurredAt: "2026-07-25T10:00:00.000Z",
  createdAt: "2026-07-25T10:00:00.000Z"
} as const;

const assistantMessage = {
  messageRef: "message:assistant-0002",
  threadRef: "thread:chat-0001",
  threadSequence: 2,
  clientMessageId: "assistant:message-0002",
  actor: {
    type: "assistant",
    assignmentRef: "assignment:alice",
    agentRef: "agent:personal-assistant",
    providerProfileRef: "provider-profile:fake-local"
  },
  origin: {
    deviceRef: null,
    connectionRef: null,
    entryAudience: "personal"
  },
  content: { type: "text", text: "这是回复。", language: "zh-CN" },
  occurredAt: "2026-07-25T10:00:01.000Z",
  createdAt: "2026-07-25T10:00:01.000Z"
} as const;

describe("Member Web thread model", () => {
  it("deduplicates authoritative messages and keeps strict thread order", () => {
    const merged = mergeThreadMessages(
      [assistantMessage, personMessage],
      [personMessage, { ...assistantMessage }]
    );

    expect(merged.map((message) => message.messageRef)).toEqual([
      "message:person-0001",
      "message:assistant-0002"
    ]);
    expect(merged.map((message) => message.threadSequence)).toEqual([1, 2]);
  });

  it("creates a retryable logical message and preserves its identity on retry", () => {
    const outgoing = createOutgoingMessage({
      threadRef: "thread:chat-0001",
      clientMessageId: "web:retry-0001",
      occurredAt: "2026-07-25T10:05:00.000Z",
      content: { type: "text", text: "请继续。", language: "zh-CN" }
    });

    expect(outgoing).toMatchObject({
      status: "sending",
      threadRef: "thread:chat-0001",
      clientMessageId: "web:retry-0001"
    });

    const retried = retryPayload({
      ...outgoing,
      status: "failed",
      error: { code: "PROVIDER_FAILED", message: "回复失败", retryable: true }
    });

    expect(retried).toEqual({
      protocolVersion: 1,
      clientMessageId: "web:retry-0001",
      occurredAt: "2026-07-25T10:05:00.000Z",
      content: { type: "text", text: "请继续。", language: "zh-CN" }
    });
  });

  it("reconciles only the outgoing message accepted by the Gateway", () => {
    const first = createOutgoingMessage({
      threadRef: "thread:chat-0001",
      clientMessageId: "web:message-0001",
      occurredAt: "2026-07-25T10:00:00.000Z",
      content: personMessage.content
    });
    const second = createOutgoingMessage({
      threadRef: "thread:chat-0001",
      clientMessageId: "web:message-0002",
      occurredAt: "2026-07-25T10:06:00.000Z",
      content: { type: "text", text: "第二条消息。", language: "zh-CN" }
    });

    const remaining = reconcileOutgoing([first, second], [personMessage]);
    expect(remaining.map((message) => message.clientMessageId)).toEqual([
      "web:message-0002"
    ]);
  });
});
