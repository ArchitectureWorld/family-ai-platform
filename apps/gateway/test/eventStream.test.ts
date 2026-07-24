import { describe, expect, it } from "vitest";
import type { DomainEvent, DomainEventPage } from "../src/domainEvents.js";
import {
  PersonEventStreamHub,
  formatConnectedFrame,
  formatDomainEventFrame,
  formatHeartbeatFrame,
  parseEventStreamCursor,
  type EventStreamAuthenticator,
  type EventStreamSink,
  type PersonEventSource
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

function event(sequence: number, personRef = "person:test"): DomainEvent {
  return {
    eventRef: `event:${personRef}-${sequence}`,
    personRef,
    eventSequence: sequence,
    eventType: "thread.message.created",
    aggregateType: "thread_message",
    aggregateRef: `message:${personRef}-${sequence}`,
    threadRef: `thread:${personRef}`,
    payload: {
      messageRef: `message:${personRef}-${sequence}`,
      actorType: sequence % 2 === 0 ? "assistant" : "person"
    },
    occurredAt: `2026-07-24T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    createdAt: `2026-07-24T12:00:${String(sequence).padStart(2, "0")}.000Z`
  };
}

class FakeEventSource implements PersonEventSource {
  readonly calls: Array<{
    personRef: string;
    afterSequence: number;
    limit: number;
  }> = [];

  constructor(readonly events: DomainEvent[]) {}

  listPersonEvents(input: {
    personRef: string;
    afterSequence?: number;
    limit?: number;
  }): DomainEventPage {
    const afterSequence = input.afterSequence ?? 0;
    const limit = input.limit ?? 100;
    this.calls.push({ personRef: input.personRef, afterSequence, limit });
    const matching = this.events
      .filter((item) => item.personRef === input.personRef && item.eventSequence > afterSequence)
      .sort((left, right) => left.eventSequence - right.eventSequence);
    const page = matching.slice(0, limit);
    return {
      events: page,
      nextAfterSequence: matching.length > limit && page.length > 0
        ? page[page.length - 1]!.eventSequence
        : null
    };
  }
}

class FakeSink implements EventStreamSink {
  readonly frames: string[] = [];
  ended = false;
  destroyed = false;

  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }

  once(_event: "drain", _listener: () => void): this {
    return this;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  domainEventIds(): number[] {
    return this.frames.flatMap((frame) => {
      const match = /^id: (\d+)$/m.exec(frame);
      return match?.[1] ? [Number(match[1])] : [];
    });
  }
}

const validAuthenticator: EventStreamAuthenticator = {
  authenticate: () => ({
    status: "authenticated",
    context: {
      audience: "personal",
      person: { personRef: "person:test" }
    }
  })
};

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

describe("PersonEventStreamHub shared pump", () => {
  it("shares one Person query and schedules only events newer than each Subscriber cursor", async () => {
    const source = new FakeEventSource([event(1), event(2), event(3)]);
    const hub = new PersonEventStreamHub(source, validAuthenticator, { autoStart: false });
    const first = new FakeSink();
    const second = new FakeSink();

    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:first",
      token: "token-first",
      sink: first
    });
    hub.register({
      personRef: "person:test",
      cursor: 2,
      entrySessionRef: "entry-session:second",
      token: "token-second",
      sink: second
    });
    await hub.pumpPerson("person:test");

    expect(source.calls).toEqual([{
      personRef: "person:test",
      afterSequence: 0,
      limit: 200
    }]);
    expect(first.domainEventIds()).toEqual([1, 2, 3]);
    expect(second.domainEventIds()).toEqual([3]);
    await hub.close();
  });

  it("keeps Person channels isolated and does not duplicate queued events", async () => {
    const source = new FakeEventSource([
      event(1, "person:test"),
      event(2, "person:test"),
      event(1, "person:other")
    ]);
    const hub = new PersonEventStreamHub(source, validAuthenticator, { autoStart: false });
    const owner = new FakeSink();
    const other = new FakeSink();

    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:owner",
      token: "owner-token",
      sink: owner
    });
    hub.register({
      personRef: "person:other",
      cursor: 0,
      entrySessionRef: "entry-session:other",
      token: "other-token",
      sink: other
    });
    await hub.pumpAll();
    await hub.pumpAll();

    expect(owner.domainEventIds()).toEqual([1, 2]);
    expect(other.domainEventIds()).toEqual([1]);
    expect(owner.frames.join("\n")).not.toContain("person:other");
    expect(other.frames.join("\n")).not.toContain("person:test");
    await hub.close();
  });

  it("reads all pages in strict ascending order", async () => {
    const source = new FakeEventSource(
      Array.from({ length: 205 }, (_, index) => event(index + 1))
    );
    const hub = new PersonEventStreamHub(source, validAuthenticator, { autoStart: false });
    const sink = new FakeSink();
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:paged",
      token: "paged-token",
      sink
    });

    await hub.pumpPerson("person:test");

    expect(sink.domainEventIds()).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));
    expect(source.calls).toEqual([
      { personRef: "person:test", afterSequence: 0, limit: 200 },
      { personRef: "person:test", afterSequence: 200, limit: 200 }
    ]);
    await hub.close();
  });
});
