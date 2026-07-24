import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DomainEvent, DomainEventPage } from "./domainEvents.js";
import { GatewayDomainError } from "./service.js";

const eventStreamQuerySchema = z
  .object({
    afterSequence: z.string().regex(/^\d+$/).optional()
  })
  .strict();

function invalidCursor(): GatewayDomainError {
  return new GatewayDomainError(
    "REQUEST_INVALID",
    400,
    "validation",
    false,
    "事件 Cursor 不正确。"
  );
}

function parseDecimalCursor(value: string): number {
  if (!/^\d+$/.test(value)) throw invalidCursor();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidCursor();
  return parsed;
}

export function parseEventStreamCursor(
  query: unknown,
  lastEventId: string | string[] | undefined
): number {
  const parsedQuery = eventStreamQuerySchema.safeParse(query);
  if (!parsedQuery.success) throw invalidCursor();
  if (Array.isArray(lastEventId)) throw invalidCursor();

  const queryCursor = parsedQuery.data.afterSequence === undefined
    ? null
    : parseDecimalCursor(parsedQuery.data.afterSequence);
  const headerCursor = lastEventId === undefined
    ? null
    : parseDecimalCursor(lastEventId);

  if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor) {
    throw invalidCursor();
  }
  return queryCursor ?? headerCursor ?? 0;
}

export function formatConnectedFrame(reconnectMs: number): string {
  return `retry: ${reconnectMs}\n: connected\n\n`;
}

export function formatDomainEventFrame(event: DomainEvent): string {
  return `id: ${event.eventSequence}\nevent: domain-event\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatHeartbeatFrame(timestamp: string): string {
  return `: heartbeat ${timestamp}\n\n`;
}

export interface PersonEventSource {
  listPersonEvents(input: {
    personRef: string;
    afterSequence?: number;
    limit?: number;
  }): DomainEventPage;
}

export type EventStreamAuthentication =
  | {
      status: "authenticated";
      context: {
        audience: string;
        person: { personRef: string };
      };
    }
  | { status: "expired" | "device_revoked" | "invalid" };

export interface EventStreamAuthenticator {
  authenticate(entrySessionRef: string, token: string): EventStreamAuthentication;
}

export interface EventStreamSink {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  end(): void;
  destroy(error?: Error): void;
}

export interface EventStreamSubscriberInput {
  personRef: string;
  cursor: number;
  entrySessionRef: string;
  token: string;
  sink: EventStreamSink;
}

export interface PersonEventStreamHubOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  reconnectMs?: number;
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
  autoStart?: boolean;
  now?: () => Date;
}

interface Subscriber {
  id: string;
  personRef: string;
  scheduledCursor: number;
  entrySessionRef: string;
  token: string;
  sink: EventStreamSink;
  closed: boolean;
  tail: Promise<void>;
  queuedFrames: number;
  queuedBytes: number;
  releaseDrain: (() => void) | null;
}

interface PersonChannel {
  subscribers: Set<Subscriber>;
  runningPump: Promise<void> | null;
  pumpAgain: boolean;
}

export class PersonEventStreamHub {
  private readonly channels = new Map<string, PersonChannel>();
  private readonly reconnectMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxQueuedFrames: number;
  private readonly maxQueuedBytes: number;
  private readonly now: () => Date;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly source: PersonEventSource,
    private readonly authenticator: EventStreamAuthenticator,
    options: PersonEventStreamHubOptions = {}
  ) {
    this.reconnectMs = options.reconnectMs ?? 3000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
    this.maxQueuedFrames = options.maxQueuedFrames ?? 256;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024;
    this.now = options.now ?? (() => new Date());
    if (options.autoStart !== false) this.start();
  }

  register(input: EventStreamSubscriberInput): () => void {
    if (this.closed) throw new Error("EVENT_STREAM_HUB_CLOSED");
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) throw invalidCursor();

    const subscriber: Subscriber = {
      id: `subscriber:${randomUUID()}`,
      personRef: input.personRef,
      scheduledCursor: input.cursor,
      entrySessionRef: input.entrySessionRef,
      token: input.token,
      sink: input.sink,
      closed: false,
      tail: Promise.resolve(),
      queuedFrames: 0,
      queuedBytes: 0,
      releaseDrain: null
    };
    let channel = this.channels.get(input.personRef);
    if (!channel) {
      channel = {
        subscribers: new Set(),
        runningPump: null,
        pumpAgain: false
      };
      this.channels.set(input.personRef, channel);
    }
    channel.subscribers.add(subscriber);
    this.enqueueFrame(subscriber, formatConnectedFrame(this.reconnectMs));
    if (this.pollTimer) void this.pumpPerson(input.personRef);

    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      this.unregister(subscriber, false);
    };
  }

  async pumpPerson(personRef: string): Promise<void> {
    if (this.closed) return;
    const channel = this.channels.get(personRef);
    if (!channel || channel.subscribers.size === 0) return;
    if (channel.runningPump) {
      channel.pumpAgain = true;
      await channel.runningPump;
      return;
    }

    const run = (async () => {
      do {
        channel.pumpAgain = false;
        this.pumpPersonPass(personRef, channel);
      } while (!this.closed && channel.pumpAgain && channel.subscribers.size > 0);
    })();
    channel.runningPump = run;
    try {
      await run;
    } finally {
      if (channel.runningPump === run) channel.runningPump = null;
      if (channel.subscribers.size === 0) this.channels.delete(personRef);
    }
  }

  async pumpAll(): Promise<void> {
    if (this.closed) return;
    await Promise.all([...this.channels.keys()].map((personRef) => this.pumpPerson(personRef)));
  }

  async heartbeatAll(): Promise<void> {
    if (this.closed) return;
    const timestamp = this.now().toISOString();
    for (const channel of [...this.channels.values()]) {
      for (const subscriber of [...channel.subscribers]) {
        if (subscriber.closed) continue;
        const authentication = this.authenticator.authenticate(
          subscriber.entrySessionRef,
          subscriber.token
        );
        if (
          authentication.status !== "authenticated" ||
          authentication.context.audience !== "personal" ||
          authentication.context.person.personRef !== subscriber.personRef
        ) {
          this.unregister(subscriber, false);
          continue;
        }
        this.enqueueFrame(subscriber, formatHeartbeatFrame(timestamp));
      }
    }
  }

  subscriberCount(personRef?: string): number {
    if (personRef !== undefined) {
      return this.channels.get(personRef)?.subscribers.size ?? 0;
    }
    let count = 0;
    for (const channel of this.channels.values()) count += channel.subscribers.size;
    return count;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;

    const subscribers = [...this.channels.values()]
      .flatMap((channel) => [...channel.subscribers]);
    for (const subscriber of subscribers) this.unregister(subscriber, true);
    await Promise.allSettled(subscribers.map((subscriber) => subscriber.tail));
    this.channels.clear();
  }

  private start(): void {
    this.pollTimer = setInterval(() => {
      void this.pumpAll();
    }, this.pollIntervalMs);
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatAll();
    }, this.heartbeatIntervalMs);
    this.pollTimer.unref?.();
    this.heartbeatTimer.unref?.();
  }

  private pumpPersonPass(personRef: string, channel: PersonChannel): void {
    const live = [...channel.subscribers].filter((subscriber) => !subscriber.closed);
    if (live.length === 0) return;
    let afterSequence = Math.min(...live.map((subscriber) => subscriber.scheduledCursor));

    while (!this.closed) {
      const page = this.source.listPersonEvents({
        personRef,
        afterSequence,
        limit: 200
      });
      let previousSequence = afterSequence;
      for (const domainEvent of page.events) {
        if (
          domainEvent.personRef !== personRef ||
          domainEvent.eventSequence <= previousSequence
        ) {
          throw new Error("EVENT_STREAM_SOURCE_ORDER_INVALID");
        }
        previousSequence = domainEvent.eventSequence;
        for (const subscriber of [...channel.subscribers]) {
          if (!subscriber.closed && subscriber.scheduledCursor < domainEvent.eventSequence) {
            subscriber.scheduledCursor = domainEvent.eventSequence;
            this.enqueueFrame(subscriber, formatDomainEventFrame(domainEvent));
          }
        }
      }
      if (page.nextAfterSequence === null) return;
      if (page.nextAfterSequence <= afterSequence || page.events.length === 0) {
        throw new Error("EVENT_STREAM_SOURCE_CURSOR_INVALID");
      }
      afterSequence = page.nextAfterSequence;
    }
  }

  private enqueueFrame(subscriber: Subscriber, frame: string): void {
    if (subscriber.closed) return;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (
      subscriber.queuedFrames + 1 > this.maxQueuedFrames ||
      subscriber.queuedBytes + bytes > this.maxQueuedBytes
    ) {
      this.unregister(subscriber, false);
      return;
    }

    subscriber.queuedFrames += 1;
    subscriber.queuedBytes += bytes;
    subscriber.tail = subscriber.tail
      .then(async () => {
        if (subscriber.closed) return;
        const writable = subscriber.sink.write(frame);
        if (!writable) await this.waitForDrain(subscriber);
      })
      .catch(() => {
        this.unregister(subscriber, false);
      })
      .finally(() => {
        subscriber.queuedFrames = Math.max(0, subscriber.queuedFrames - 1);
        subscriber.queuedBytes = Math.max(0, subscriber.queuedBytes - bytes);
      });
  }

  private async waitForDrain(subscriber: Subscriber): Promise<void> {
    if (subscriber.closed) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        if (subscriber.releaseDrain === release) subscriber.releaseDrain = null;
        resolve();
      };
      subscriber.releaseDrain = release;
      subscriber.sink.once("drain", release);
      if (subscriber.closed) release();
    });
  }

  private unregister(subscriber: Subscriber, end: boolean): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.releaseDrain?.();
    subscriber.releaseDrain = null;
    subscriber.entrySessionRef = "";
    subscriber.token = "";
    const channel = this.channels.get(subscriber.personRef);
    channel?.subscribers.delete(subscriber);
    if (channel && channel.subscribers.size === 0 && !channel.runningPump) {
      this.channels.delete(subscriber.personRef);
    }
    try {
      if (end) subscriber.sink.end();
      else subscriber.sink.destroy();
    } catch {
      // The connection is already unusable; cleanup is still complete.
    }
  }
}
