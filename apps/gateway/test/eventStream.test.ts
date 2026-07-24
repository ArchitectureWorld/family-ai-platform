import { describe, expect, it } from "vitest";
import type { DomainEvent } from "../src/domainEvents.js";
import {
  formatConnectedFrame,
  formatDomainEventFrame,
  formatHeartbeatFrame,
  parseEventStreamCursor
} from "../src/eventStream.js";

function expectInvalidCursor(run: () => unknown): void {
  try {
    run();
    throw new Error("Expected invalid event stream cursor");
  } catch (error) {
    expect(error).toMatchObject({
      code: "REQUEST_INVALID",
      statusCode: 400,
      category: "validation",
      retryable: false
    });
  }
}

function event(sequence: number): DomainEvent {
  return {
    eventRef: `event:test-${sequence}`,
    personRef: "person:test",
    eventSequence: sequence,
    eventType: "thread.message.created",
    aggregateType: "thread_message",
    aggregateRef: `message:test-${sequence}`,
    threadRef: "thread:test",
    payload: {
      messageRef: `message:test-${sequence}`,
      actorType: sequence % 2 === 0 ? "assistant" : "person"
    },
    occurredAt: `2026-07-24T12:00:0${sequence}.000Z`,
    createdAt: `2026-07-24T12:00:0${sequence}.000Z`
  };
}

describe("Chat Work SSE protocol helpers", () => {
  it("parses exclusive cursor inputs from query or Last-Event-ID", () => {
    expect(parseEventStreamCursor({}, undefined)).toBe(0);
    expect(parseEventStreamCursor({ afterSequence: "12" }, undefined)).toBe(12);
    expect(parseEventStreamCursor({}, "12")).toBe(12);
    expect(parseEventStreamCursor({ afterSequence: "12" }, "12")).toBe(12);
  });

  it("rejects malformed, unsafe, unknown and conflicting cursor inputs", () => {
    for (const [query, lastEventId] of [
      [{ afterSequence: "-1" }, undefined],
      [{ afterSequence: "1.5" }, undefined],
      [{ afterSequence: "9007199254740992" }, undefined],
      [{ afterSequence: ["1", "2"] }, undefined],
      [{ unknown: "1" }, undefined],
      [{ afterSequence: "12" }, "13"],
      [{}, "not-decimal"],
      [{}, ["1", "2"]]
    ] as const) {
      expectInvalidCursor(() => parseEventStreamCursor(query, lastEventId));
    }
  });

  it("formats connected, domain-event and heartbeat frames", () => {
    expect(formatConnectedFrame(3000)).toBe("retry: 3000\n: connected\n\n");
    expect(formatHeartbeatFrame("2026-07-24T12:00:00.000Z"))
      .toBe(": heartbeat 2026-07-24T12:00:00.000Z\n\n");

    const frame = formatDomainEventFrame(event(7));
    expect(frame).toContain("id: 7\n");
    expect(frame).toContain("event: domain-event\n");
    expect(frame).toContain("data: {");
    expect(frame).toContain('"eventSequence":7');
    expect(frame).toContain('"actorType":"person"');
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame.split("\n").filter((line) => line.startsWith("data: "))).toHaveLength(1);
  });

  it("never assigns an event ID to connected or heartbeat comments", () => {
    expect(formatConnectedFrame(3000)).not.toContain("id:");
    expect(formatHeartbeatFrame("2026-07-24T12:00:00.000Z")).not.toContain("id:");
  });
});
