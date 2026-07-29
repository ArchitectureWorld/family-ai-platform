import { describe, expect, it } from "vitest";
import { eventRefreshPlan } from "../member-public/sync.js";
import {
  outgoingPresentation,
  retryPayload
} from "../member-public/thread.js";

const acceptedMessage = {
  messageRef: "message:person-0001",
  threadRef: "thread:work-0001",
  threadSequence: 1,
  clientMessageId: "web:work-message-0001",
  actor: { type: "person", personRef: "person:alice" },
  origin: { deviceRef: "device:web-alice", connectionRef: null, entryAudience: "personal" },
  content: { type: "text", text: "请继续推进。", language: "zh-CN" },
  occurredAt: "2026-07-25T10:00:00.000Z",
  createdAt: "2026-07-25T10:00:00.000Z"
};

describe("Member Web projection review boundaries", () => {
  it("refreshes an inactive Thread so switching sections never reveals stale messages", () => {
    const plan = eventRefreshPlan({
      eventType: "thread.message.created",
      threadRef: "thread:work-0001",
      payload: {
        messageRef: "message:person-0001",
        threadRef: "thread:work-0001",
        threadSequence: 1,
        actorType: "person",
        clientMessageId: "web:work-message-0001"
      }
    }, "thread:chat-0001");

    expect(plan).toEqual({
      chat: false,
      works: false,
      threads: ["thread:work-0001"],
      progress: []
    });
  });

  it("renders an accepted Person message once and represents Provider failure as retry status", () => {
    const failed = {
      threadRef: "thread:work-0001",
      clientMessageId: "web:work-message-0001",
      occurredAt: "2026-07-25T10:00:00.000Z",
      requestContent: acceptedMessage.content,
      content: {
        type: "text",
        text: "个人助理回复失败，可以重试。",
        language: "zh-CN"
      },
      status: "failed",
      error: {
        code: "PROVIDER_FAILED",
        category: "availability",
        message: "个人助理回复失败，可以重试。",
        retryable: true
      }
    };

    expect(outgoingPresentation(failed, [acceptedMessage])).toEqual({
      kind: "reply_failure",
      text: "个人助理回复失败，可以重试。",
      accepted: true
    });
    expect(outgoingPresentation({
      ...failed,
      clientMessageId: "web:not-accepted",
      content: acceptedMessage.content
    }, [acceptedMessage])).toEqual({
      kind: "send_failure",
      text: "请继续推进。",
      accepted: false
    });
    expect(retryPayload(failed)).toEqual({
      protocolVersion: 1,
      clientMessageId: "web:work-message-0001",
      occurredAt: "2026-07-25T10:00:00.000Z",
      content: acceptedMessage.content,
      attachmentRefs: []
    });
  });
});
