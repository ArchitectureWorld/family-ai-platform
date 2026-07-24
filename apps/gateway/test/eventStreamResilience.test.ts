import { describe, expect, it } from "vitest";
import type { DomainEvent, DomainEventPage } from "../src/domainEvents.js";
import {
  PersonEventStreamHub,
  type EventStreamAuthenticator,
  type EventStreamSink,
  type PersonEventSource
} from "../src/eventStream.js";

function domainEvent(personRef: string, sequence: number): DomainEvent {
  return {
    eventRef: `event:${personRef}-${sequence}`,
    personRef,
    eventSequence: sequence,
    eventType: "work.created",
    aggregateType: "work",
    aggregateRef: `work:${personRef}-${sequence}`,
    threadRef: `thread:${personRef}`,
    payload: { workConversationRef: `work:${personRef}-${sequence}` },
    occurredAt: "2026-07-24T13:00:00.000Z",
    createdAt: "2026-07-24T13:00:00.000Z"
  };
}

class PartiallyFailingSource implements PersonEventSource {
  readonly calls: string[] = [];

  listPersonEvents(input: {
    personRef: string;
    afterSequence?: number;
    limit?: number;
  }): DomainEventPage {
    this.calls.push(input.personRef);
    if (input.personRef === "person:failing") {
      throw new Error("SIMULATED_PERSON_EVENT_READ_FAILURE");
    }
    return {
      events: input.afterSequence === 0 || input.afterSequence === undefined
        ? [domainEvent(input.personRef, 1)]
        : [],
      nextAfterSequence: null
    };
  }
}

class RecordingSink implements EventStreamSink {
  readonly frames: string[] = [];
  destroyed = false;
  ended = false;
  private waiter: (() => void) | null = null;

  write(chunk: string): boolean {
    this.frames.push(chunk);
    if (chunk.startsWith("id: ")) {
      this.waiter?.();
      this.waiter = null;
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

  async waitForDomainEvent(): Promise<void> {
    if (this.frames.some((frame) => frame.startsWith("id: "))) return;
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }
}

const authenticator: EventStreamAuthenticator = {
  authenticate: (_entrySessionRef, token) => ({
    status: "authenticated",
    context: {
      audience: "personal",
      person: { personRef: token }
    }
  })
};

describe("PersonEventStreamHub failure isolation", () => {
  it("does not reject or block healthy Person channels when one Person query fails", async () => {
    const source = new PartiallyFailingSource();
    const hub = new PersonEventStreamHub(source, authenticator, { autoStart: false });
    const failing = new RecordingSink();
    const healthy = new RecordingSink();
    hub.register({
      personRef: "person:failing",
      cursor: 0,
      entrySessionRef: "entry-session:failing",
      token: "person:failing",
      sink: failing
    });
    hub.register({
      personRef: "person:healthy",
      cursor: 0,
      entrySessionRef: "entry-session:healthy",
      token: "person:healthy",
      sink: healthy
    });

    try {
      await expect(hub.pumpAll()).resolves.toBeUndefined();
      await healthy.waitForDomainEvent();
      expect(healthy.frames.join("\n")).toContain("id: 1");
      expect(healthy.frames.join("\n")).toContain('"personRef":"person:healthy"');
      expect(failing.frames.join("\n")).not.toContain("id: ");
      expect(source.calls).toEqual(expect.arrayContaining([
        "person:failing",
        "person:healthy"
      ]));
    } finally {
      await hub.close();
    }
  });

  it("closes only the connection whose heartbeat authentication throws", async () => {
    const source: PersonEventSource = {
      listPersonEvents: () => ({ events: [], nextAfterSequence: null })
    };
    const heartbeatAuthenticator: EventStreamAuthenticator = {
      authenticate: (entrySessionRef, token) => {
        if (entrySessionRef === "entry-session:failing") {
          throw new Error("SIMULATED_AUTHENTICATION_FAILURE");
        }
        return {
          status: "authenticated",
          context: {
            audience: "personal",
            person: { personRef: token }
          }
        };
      }
    };
    const hub = new PersonEventStreamHub(source, heartbeatAuthenticator, {
      autoStart: false,
      now: () => new Date("2026-07-24T13:15:00.000Z")
    });
    const failing = new RecordingSink();
    const healthy = new RecordingSink();
    hub.register({
      personRef: "person:failing",
      cursor: 0,
      entrySessionRef: "entry-session:failing",
      token: "person:failing",
      sink: failing
    });
    hub.register({
      personRef: "person:healthy",
      cursor: 0,
      entrySessionRef: "entry-session:healthy",
      token: "person:healthy",
      sink: healthy
    });

    try {
      await expect(hub.heartbeatAll()).resolves.toBeUndefined();
      expect(failing.destroyed).toBe(true);
      expect(healthy.destroyed).toBe(false);
      expect(healthy.frames.at(-1)).toBe(
        ": heartbeat 2026-07-24T13:15:00.000Z\n\n"
      );
      expect(hub.subscriberCount()).toBe(1);
    } finally {
      await hub.close();
    }
  });
});
