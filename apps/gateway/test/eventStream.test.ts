import { describe, expect, it } from "vitest";
import type { DomainEvent, DomainEventPage } from "../src/domainEvents.js";
import {
  PersonEventStreamHub,
  formatConnectedFrame,
  formatDomainEventFrame,
  formatEntryRevokedFrame,
  formatHeartbeatFrame,
  parseEventStreamCursor,
  type EventStreamAuthentication,
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
  const messageRef = `message:${personRef}-${sequence}`;
  const threadRef = `thread:${personRef}`;
  const occurredAt = new Date(Date.UTC(2026, 6, 24, 12, 0, sequence)).toISOString();
  return {
    eventRef: `event:${personRef}-${sequence}`,
    personRef,
    eventSequence: sequence,
    eventType: "thread.message.created",
    aggregateType: "thread_message",
    aggregateRef: messageRef,
    threadRef,
    payload: {
      messageRef,
      threadRef,
      threadSequence: sequence,
      actorType: sequence % 2 === 0 ? "assistant" : "person",
      clientMessageId: `sse-${personRef}-${sequence}`
    },
    occurredAt,
    createdAt: occurredAt
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
  private readonly waiters: Array<{
    predicate: (frame: string) => boolean;
    resolve: () => void;
  }> = [];

  write(chunk: string): boolean {
    this.frames.push(chunk);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter && this.frames.some(waiter.predicate)) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
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

  async waitForFrame(predicate: (frame: string) => boolean): Promise<void> {
    if (this.frames.some(predicate)) return;
    await new Promise<void>((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  async waitForDomainEvents(count: number): Promise<void> {
    await this.waitForFrame(() => this.domainEventIds().length >= count);
  }
}

class BackpressureSink extends FakeSink {
  private drainListener: (() => void) | null = null;
  private blockedDomainEvent = false;

  override write(chunk: string): boolean {
    super.write(chunk);
    if (!this.blockedDomainEvent && chunk.startsWith("id: ")) {
      this.blockedDomainEvent = true;
      return false;
    }
    return true;
  }

  override once(_event: "drain", listener: () => void): this {
    this.drainListener = listener;
    return this;
  }

  releaseDrain(): void {
    const listener = this.drainListener;
    this.drainListener = null;
    listener?.();
  }
}

class RevokedBackpressureSink extends BackpressureSink {
  readonly lifecycle: string[] = [];

  override write(chunk: string): boolean {
    const writable = super.write(chunk);
    if (chunk.startsWith("event: entry-revoked")) {
      this.lifecycle.push("control-accepted");
      return false;
    }
    return writable;
  }

  override end(): void {
    this.lifecycle.push("end");
    super.end();
  }
}

class MutableAuthenticator implements EventStreamAuthenticator {
  readonly calls: Array<[string, string]> = [];
  private readonly results = new Map<string, EventStreamAuthentication>();

  set(entrySessionRef: string, result: EventStreamAuthentication): void {
    this.results.set(entrySessionRef, result);
  }

  authenticate(entrySessionRef: string, token: string): EventStreamAuthentication {
    this.calls.push([entrySessionRef, token]);
    return this.results.get(entrySessionRef) ?? { status: "invalid" };
  }
}

function authenticated(personRef: string, audience = "personal"): EventStreamAuthentication {
  return {
    status: "authenticated",
    context: {
      audience,
      person: { personRef }
    }
  };
}

const validAuthenticator: EventStreamAuthenticator = {
  authenticate: () => authenticated("person:test")
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

  it("formats the exact non-secret Web Entry revoke control frame", () => {
    const frame = formatEntryRevokedFrame();
    expect(frame).toBe(
      "event: entry-revoked\ndata: {\"protocolVersion\":2,\"type\":\"device_revoked\"}\n\n"
    );
    expect(frame).not.toMatch(/^id:/m);
    expect(frame).not.toMatch(/person|deviceRef|entrySessionRef|cursor|cookie|token/i);
    expect(frame.split("\n").filter((line) => line.startsWith("data: ")))
      .toHaveLength(1);
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
      authenticationSource: "explicit_authorization",
      sink: first
    });
    hub.register({
      personRef: "person:test",
      cursor: 2,
      entrySessionRef: "entry-session:second",
      token: "token-second",
      authenticationSource: "explicit_authorization",
      sink: second
    });
    await hub.pumpPerson("person:test");
    await Promise.all([
      first.waitForDomainEvents(3),
      second.waitForDomainEvents(1)
    ]);

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
      authenticationSource: "explicit_authorization",
      sink: owner
    });
    hub.register({
      personRef: "person:other",
      cursor: 0,
      entrySessionRef: "entry-session:other",
      token: "other-token",
      authenticationSource: "explicit_authorization",
      sink: other
    });
    await hub.pumpAll();
    await Promise.all([
      owner.waitForDomainEvents(2),
      other.waitForDomainEvents(1)
    ]);
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
      authenticationSource: "explicit_authorization",
      sink
    });

    await hub.pumpPerson("person:test");
    await sink.waitForDomainEvents(205);

    expect(sink.domainEventIds()).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));
    expect(source.calls).toEqual([
      { personRef: "person:test", afterSequence: 0, limit: 200 },
      { personRef: "person:test", afterSequence: 200, limit: 200 }
    ]);
    await hub.close();
  });
});

describe("PersonEventStreamHub connection protection", () => {
  it("waits for drain before writing the next frame to one slow Subscriber", async () => {
    const source = new FakeEventSource([event(1), event(2)]);
    const hub = new PersonEventStreamHub(source, validAuthenticator, { autoStart: false });
    const sink = new BackpressureSink();
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:backpressure",
      token: "backpressure-token",
      authenticationSource: "explicit_authorization",
      sink
    });

    await hub.pumpPerson("person:test");
    await sink.waitForDomainEvents(1);
    expect(sink.domainEventIds()).toEqual([1]);

    sink.releaseDrain();
    await sink.waitForDomainEvents(2);
    expect(sink.domainEventIds()).toEqual([1, 2]);
    await hub.close();
  });

  it("closes only a slow Subscriber whose queued-frame limit is exceeded", async () => {
    const source = new FakeEventSource([event(1)]);
    const hub = new PersonEventStreamHub(source, validAuthenticator, {
      autoStart: false,
      maxQueuedFrames: 2
    });
    const slow = new BackpressureSink();
    const healthy = new FakeSink();
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:slow",
      token: "slow-token",
      authenticationSource: "explicit_authorization",
      sink: slow
    });
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:healthy",
      token: "healthy-token",
      authenticationSource: "explicit_authorization",
      sink: healthy
    });

    await hub.pumpPerson("person:test");
    await Promise.all([
      slow.waitForDomainEvents(1),
      healthy.waitForDomainEvents(1)
    ]);
    source.events.push(event(2), event(3));
    await hub.pumpPerson("person:test");
    await healthy.waitForDomainEvents(3);

    expect(slow.destroyed).toBe(true);
    expect(healthy.destroyed).toBe(false);
    expect(healthy.domainEventIds()).toEqual([1, 2, 3]);
    await hub.close();
  });

  it("closes a Subscriber when queued bytes exceed the configured process boundary", async () => {
    const large = event(1);
    large.eventType = "notification.created";
    large.aggregateType = "notification";
    large.aggregateRef = "notification:person-test-1";
    large.threadRef = null;
    large.payload = { padding: "x".repeat(2048) };
    const source = new FakeEventSource([large]);
    const hub = new PersonEventStreamHub(source, validAuthenticator, {
      autoStart: false,
      maxQueuedBytes: 256
    });
    const sink = new FakeSink();
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:large",
      token: "large-token",
      authenticationSource: "explicit_authorization",
      sink
    });

    await hub.pumpPerson("person:test");

    expect(sink.destroyed).toBe(true);
    expect(hub.subscriberCount()).toBe(0);
    await hub.close();
  });


  it("notifies Cookie subscribers before gracefully ending a revoked stream", async () => {
    const source = new FakeEventSource([]);
    const authenticator = new MutableAuthenticator();
    authenticator.set("entry-session:web", authenticated("person:test"));
    const sink = new FakeSink();
    const hub = new PersonEventStreamHub(source, authenticator, { autoStart: false });
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:web",
      token: "cookie-token",
      authenticationSource: "entry_cookie",
      sink
    });

    authenticator.set("entry-session:web", { status: "device_revoked" });
    await hub.heartbeatAll();

    const controlFrame =
      "event: entry-revoked\ndata: {\"protocolVersion\":2,\"type\":\"device_revoked\"}\n\n";
    expect(sink.frames.filter((frame) => frame === controlFrame)).toHaveLength(1);
    expect(sink.ended).toBe(true);
    expect(sink.destroyed).toBe(false);
    await hub.close();
  });

  it("keeps explicit Bearer device-revoke closure free of Cookie control frames", async () => {
    const source = new FakeEventSource([]);
    const authenticator = new MutableAuthenticator();
    authenticator.set("entry-session:explicit", authenticated("person:test"));
    const sink = new FakeSink();
    const hub = new PersonEventStreamHub(source, authenticator, { autoStart: false });
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:explicit",
      token: "explicit-token",
      authenticationSource: "explicit_authorization",
      sink
    });

    authenticator.set("entry-session:explicit", { status: "device_revoked" });
    await hub.heartbeatAll();

    expect(sink.frames.join("\n")).not.toContain("event: entry-revoked");
    expect(sink.ended).toBe(false);
    expect(sink.destroyed).toBe(true);
    expect(hub.subscriberCount()).toBe(0);
    await hub.close();
  });

  it("accepts one direct revoke control before end while a domain frame waits for drain", async () => {
    const source = new FakeEventSource([event(1), event(2)]);
    const authenticator = new MutableAuthenticator();
    authenticator.set("entry-session:blocked", authenticated("person:test"));
    const sink = new RevokedBackpressureSink();
    const hub = new PersonEventStreamHub(source, authenticator, { autoStart: false });
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:blocked",
      token: "cookie-token",
      authenticationSource: "entry_cookie",
      sink
    });

    await hub.pumpPerson("person:test");
    await sink.waitForDomainEvents(1);
    expect(sink.domainEventIds()).toEqual([1]);

    authenticator.set("entry-session:blocked", { status: "device_revoked" });
    await hub.heartbeatAll();
    await Promise.resolve();

    const controlFrame =
      "event: entry-revoked\ndata: {\"protocolVersion\":2,\"type\":\"device_revoked\"}\n\n";
    expect(sink.frames.filter((frame) => frame === controlFrame)).toHaveLength(1);
    expect(sink.lifecycle).toEqual(["control-accepted", "end"]);
    expect(sink.domainEventIds()).toEqual([1]);
    expect(sink.ended).toBe(true);
    expect(sink.destroyed).toBe(false);
    expect(hub.subscriberCount()).toBe(0);
    await hub.close();
  });

  it("revalidates credentials before heartbeat and closes invalid connections", async () => {
    const source = new FakeEventSource([]);
    const authenticator = new MutableAuthenticator();
    authenticator.set("entry-session:valid", authenticated("person:test"));
    authenticator.set("entry-session:expired", { status: "expired" });
    authenticator.set("entry-session:wrong-person", authenticated("person:other"));
    authenticator.set("entry-session:admin", authenticated("person:test", "family_admin"));
    const hub = new PersonEventStreamHub(source, authenticator, {
      autoStart: false,
      now: () => new Date("2026-07-24T12:15:00.000Z")
    });
    const valid = new FakeSink();
    const expired = new FakeSink();
    const invalid = new FakeSink();
    const wrongPerson = new FakeSink();
    const admin = new FakeSink();
    for (const [entrySessionRef, token, sink] of [
      ["entry-session:valid", "valid-token", valid],
      ["entry-session:expired", "expired-token", expired],
      ["entry-session:invalid", "invalid-token", invalid],
      ["entry-session:wrong-person", "wrong-person-token", wrongPerson],
      ["entry-session:admin", "admin-token", admin]
    ] as const) {
      hub.register({
        personRef: "person:test",
        cursor: 0,
        entrySessionRef,
        token,
        authenticationSource: "entry_cookie",
        sink
      });
    }

    await hub.heartbeatAll();
    await valid.waitForFrame((frame) => frame.startsWith(": heartbeat "));

    expect(valid.frames.at(-1)).toBe(": heartbeat 2026-07-24T12:15:00.000Z\n\n");
    expect(valid.destroyed).toBe(false);
    expect(expired.destroyed).toBe(true);
    expect(invalid.destroyed).toBe(true);
    expect(wrongPerson.destroyed).toBe(true);
    expect(admin.destroyed).toBe(true);
    expect(authenticator.calls).toEqual([
      ["entry-session:valid", "valid-token"],
      ["entry-session:expired", "expired-token"],
      ["entry-session:invalid", "invalid-token"],
      ["entry-session:wrong-person", "wrong-person-token"],
      ["entry-session:admin", "admin-token"]
    ]);
    expect(hub.subscriberCount()).toBe(1);
    await hub.close();
  });

  it("cleans every Subscriber and stops reading after Hub close", async () => {
    const source = new FakeEventSource([event(1)]);
    const hub = new PersonEventStreamHub(source, validAuthenticator, { autoStart: false });
    const sink = new FakeSink();
    hub.register({
      personRef: "person:test",
      cursor: 0,
      entrySessionRef: "entry-session:close",
      token: "close-token",
      authenticationSource: "explicit_authorization",
      sink
    });

    await hub.close();
    const callsBefore = source.calls.length;
    await hub.pumpAll();

    expect(hub.subscriberCount()).toBe(0);
    expect(sink.ended).toBe(true);
    expect(source.calls).toHaveLength(callsBefore);
  });
});
