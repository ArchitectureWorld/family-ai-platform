import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  homeChatStreamResponseSchema,
  threadMessageListResponseSchema,
  workConversationListResponseSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/chat-work/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Chat / Work protocol v1 read models", () => {
  it("accepts canonical read-model fixtures", () => {
    expect(homeChatStreamResponseSchema.parse(fixture("home-chat-response.json"))).toBeTruthy();
    expect(workConversationListResponseSchema.parse(fixture("work-list-response.json"))).toBeTruthy();
    expect(
      threadMessageListResponseSchema.parse(fixture("thread-message-list-response.json"))
    ).toBeTruthy();
  });
});
