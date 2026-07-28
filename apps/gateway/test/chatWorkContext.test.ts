import type { ThreadMessage } from "@family-ai/contracts";
import { describe, expect, it } from "vitest";
import { buildProviderContext } from "../src/chatWorkContext.js";

function message(input: {
  ref: string;
  sequence: number;
  actor: ThreadMessage["actor"];
  text: string;
}): ThreadMessage {
  return {
    messageRef: input.ref,
    threadRef: "thread:provider-context",
    threadSequence: input.sequence,
    clientMessageId: `context-message-${input.sequence}`,
    actor: input.actor,
    origin: {
      deviceRef: input.actor.type === "person" ? "device:context" : null,
      connectionRef: null,
      entryAudience: "personal"
    },
    content: { type: "text", text: input.text },
    occurredAt: `2026-07-28T00:00:${String(input.sequence).padStart(2, "0")}.000Z`,
    createdAt: `2026-07-28T00:00:${String(input.sequence).padStart(2, "0")}.000Z`
  };
}

describe("Provider history context", () => {
  it("sends only the current Person message while an external Session exists", () => {
    const current = message({
      ref: "message:current",
      sequence: 3,
      actor: { type: "person", personRef: "person:owner" },
      text: "当前问题"
    });
    expect(buildProviderContext({
      messages: [
        message({
          ref: "message:older",
          sequence: 1,
          actor: { type: "person", personRef: "person:owner" },
          text: "旧问题"
        }),
        current
      ],
      currentMessageRef: current.messageRef,
      externalSessionRef: "external-session:active"
    })).toEqual([{ type: "text", text: "当前问题" }]);
  });

  it("rebuilds a bounded visible-role capsule from recent persisted history", () => {
    const previous = Array.from({ length: 20 }, (_, index) => message({
      ref: `message:history-${index + 1}`,
      sequence: index + 1,
      actor: index % 2 === 0
        ? { type: "person", personRef: "person:owner" }
        : {
            type: "assistant",
            assignmentRef: "assignment:history",
            agentRef: "agent:personal-assistant",
            providerProfileRef: "provider-profile:fake-local"
          },
      text: `可见历史-${index + 1}`
    }));
    const current = message({
      ref: "message:retry-current",
      sequence: 22,
      actor: { type: "person", personRef: "person:owner" },
      text: "重试当前问题"
    });
    const [capsule] = buildProviderContext({
      messages: [
        ...previous,
        message({
          ref: "message:hidden-system",
          sequence: 21,
          actor: { type: "system", systemRef: "system:hidden" },
          text: "内部错误详情"
        }),
        current
      ],
      currentMessageRef: current.messageRef,
      externalSessionRef: null
    });

    expect(capsule?.text).not.toContain("可见历史-1\n");
    expect(capsule?.text).not.toContain("可见历史-2\n");
    expect(capsule?.text).toContain("成员:可见历史-3");
    expect(capsule?.text).toContain("助理:可见历史-20");
    expect(capsule?.text).toContain("成员:重试当前问题");
    expect(capsule?.text).not.toContain("内部错误详情");
    expect(capsule?.text).not.toContain("message:");
    expect(capsule?.text.length).toBeLessThanOrEqual(12_000);
  });
});
