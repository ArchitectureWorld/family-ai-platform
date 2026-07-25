import { readBootstrapSnapshot, saveMeta } from "./cache.js";

function emptyPlan() {
  return { chat: false, works: false, threads: [], progress: [] };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function eventRefreshPlan(event, activeThreadRef = null) {
  const plan = emptyPlan();
  switch (event?.eventType) {
    case "chat.home.created":
      plan.chat = true;
      break;
    case "work.created":
    case "chat.work.created":
      plan.works = true;
      break;
    case "thread.message.created":
    case "thread.provider_turn.failed":
    case "thread.provider_turn.succeeded":
      if (event.threadRef && (!activeThreadRef || event.threadRef === activeThreadRef)) {
        plan.threads = [event.threadRef];
      }
      break;
    case "work.progress.updated":
      plan.works = true;
      if (event.payload?.workConversationRef) {
        plan.progress = [event.payload.workConversationRef];
      }
      break;
    default:
      break;
  }
  plan.threads = unique(plan.threads);
  plan.progress = unique(plan.progress);
  return plan;
}

export function nextReconnectDelay(attempt) {
  const safeAttempt = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  return Math.min(30000, 1000 * (2 ** safeAttempt));
}

export function highestContiguousSequence(currentSequence, events) {
  let current = currentSequence;
  for (const event of events) {
    const sequence = Number(event?.eventSequence);
    if (!Number.isSafeInteger(sequence)) throw new Error("SYNC_SEQUENCE_INVALID");
    if (sequence <= current) throw new Error("SYNC_SEQUENCE_REGRESSION");
    if (sequence !== current + 1) throw new Error("SYNC_SEQUENCE_GAP");
    current = sequence;
  }
  return current;
}

function errorProjection(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "SYNC_FAILED",
    message: typeof error?.message === "string" ? error.message : "同步失败。",
    retryable: error?.retryable !== false
  };
}

export function createSyncController(input) {
  const { api, cache, store, applyEvent } = input;
  const EventSourceClass = input.EventSourceClass ?? globalThis.EventSource;
  const BroadcastChannelClass = input.BroadcastChannelClass ?? globalThis.BroadcastChannel;
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  const channel = typeof BroadcastChannelClass === "function"
    ? new BroadcastChannelClass("family-ai-member-web")
    : null;

  let stopped = false;
  let source = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lane = Promise.resolve();

  function reportError(error) {
    input.onError?.(error);
  }

  function updateSync(patch) {
    store.setState((current) => ({
      ...current,
      sync: {
        ...(current.sync ?? {}),
        ...patch
      }
    }));
  }

  async function snapshotSequence() {
    return (await readBootstrapSnapshot(cache)).localAppliedSequence;
  }

  async function ensureLocalBaseline(sequence) {
    const local = await snapshotSequence();
    if (sequence > local) await saveMeta(cache, "localAppliedSequence", sequence);
    return Math.max(local, sequence);
  }

  async function catchUp() {
    updateSync({ status: "syncing", error: null });
    try {
      let explicitAfter;
      let latestSequence = store.getState().sync?.latestSequence ?? 0;
      let acknowledgedSequence = store.getState().sync?.acknowledgedSequence ?? 0;
      while (!stopped) {
        const response = await api.getSyncEvents({
          ...(explicitAfter === undefined ? {} : { afterSequence: explicitAfter }),
          limit: 200
        });
        latestSequence = response.sync.latestSequence;
        acknowledgedSequence = response.sync.acknowledgedSequence;
        await ensureLocalBaseline(response.sync.requestedAfterSequence);
        for (const target of response.events) await applyEvent(target);
        if (response.events.length > 0) {
          const last = response.events.at(-1);
          await api.ackSyncEvent(last);
          acknowledgedSequence = last.eventSequence;
          channel?.postMessage({ type: "cache-updated", eventSequence: last.eventSequence });
        }
        if (response.nextAfterSequence === null) break;
        explicitAfter = response.nextAfterSequence;
      }
      const localAppliedSequence = await snapshotSequence();
      updateSync({
        status: "online",
        localAppliedSequence,
        acknowledgedSequence: Math.max(acknowledgedSequence, localAppliedSequence),
        latestSequence: Math.max(latestSequence, localAppliedSequence),
        error: null
      });
      reconnectAttempt = 0;
      return localAppliedSequence;
    } catch (error) {
      updateSync({ status: "degraded", error: errorProjection(error) });
      reportError(error);
      throw error;
    }
  }

  async function applyRealtimeEvent(target) {
    await applyEvent(target);
    await api.ackSyncEvent(target);
    const localAppliedSequence = await snapshotSequence();
    updateSync({
      status: "online",
      localAppliedSequence,
      acknowledgedSequence: Math.max(
        store.getState().sync?.acknowledgedSequence ?? 0,
        target.eventSequence
      ),
      latestSequence: Math.max(
        store.getState().sync?.latestSequence ?? 0,
        target.eventSequence
      ),
      error: null
    });
    channel?.postMessage({ type: "cache-updated", eventSequence: target.eventSequence });
  }

  function enqueueRealtime(target) {
    lane = lane
      .then(() => applyRealtimeEvent(target))
      .catch((error) => {
        updateSync({ status: "degraded", error: errorProjection(error) });
        reportError(error);
        scheduleReconnect();
      });
    return lane;
  }

  async function connect() {
    if (stopped || typeof EventSourceClass !== "function") return null;
    source?.close();
    const afterSequence = await snapshotSequence();
    const eventSource = new EventSourceClass(
      `/api/v1/events/stream?afterSequence=${encodeURIComponent(String(afterSequence))}`
    );
    source = eventSource;
    eventSource.onopen = () => {
      reconnectAttempt = 0;
      updateSync({ status: "online", error: null });
    };
    eventSource.addEventListener("domain-event", (message) => {
      try {
        const target = JSON.parse(message.data);
        if (
          message.lastEventId &&
          Number(message.lastEventId) !== Number(target.eventSequence)
        ) {
          throw new Error("SSE_EVENT_ID_MISMATCH");
        }
        void enqueueRealtime(target);
      } catch (error) {
        updateSync({ status: "degraded", error: errorProjection(error) });
        reportError(error);
        scheduleReconnect();
      }
    });
    eventSource.onerror = () => {
      if (stopped || source !== eventSource) return;
      eventSource.close();
      updateSync({ status: "offline", error: null });
      scheduleReconnect();
    };
    return eventSource;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const delay = nextReconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      lane = lane
        .then(async () => {
          await catchUp();
          await connect();
        })
        .catch(() => scheduleReconnect());
    }, delay);
  }

  async function start() {
    stopped = false;
    await catchUp();
    await connect();
  }

  function reconnectNow() {
    if (reconnectTimer !== null) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    source?.close();
    lane = lane
      .then(async () => {
        await catchUp();
        await connect();
      })
      .catch(() => scheduleReconnect());
    return lane;
  }

  function stop() {
    stopped = true;
    source?.close();
    source = null;
    if (reconnectTimer !== null) clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
    channel?.close();
  }

  if (channel) {
    channel.onmessage = (message) => {
      if (message.data?.type !== "cache-updated") return;
      const sequence = Number(message.data.eventSequence);
      if (!Number.isSafeInteger(sequence)) return;
      updateSync({
        localAppliedSequence: Math.max(
          store.getState().sync?.localAppliedSequence ?? 0,
          sequence
        )
      });
      input.onCacheUpdated?.(sequence);
    };
  }

  return {
    start,
    catchUp,
    connect,
    reconnectNow,
    stop,
    whenIdle: () => lane
  };
}
