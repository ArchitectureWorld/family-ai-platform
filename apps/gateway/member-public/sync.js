import { readBootstrapSnapshot, saveMeta } from "./cache.js";

function emptyPlan() {
  return { chat: false, works: false, threads: [], progress: [] };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function eventRefreshPlan(event, _activeThreadRef = null) {
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
      if (event.threadRef) plan.threads = [event.threadRef];
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
  const onEntryRevoked = input.onEntryRevoked ?? (() => undefined);
  const EventSourceClass = input.EventSourceClass ?? globalThis.EventSource;
  const BroadcastChannelClass = input.BroadcastChannelClass ?? globalThis.BroadcastChannel;
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  const channel = typeof BroadcastChannelClass === "function"
    ? new BroadcastChannelClass("family-ai-member-web")
    : null;

  let stopped = false;
  let revoked = false;
  let source = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lane = Promise.resolve();
  let revokeCallbackScheduled = false;
  let revokeStopBarrier = Promise.resolve();
  let revokeCallbackPromise = Promise.resolve();

  function reportError(error) {
    input.onError?.(error);
  }

  function cancelReconnect() {
    if (reconnectTimer !== null) clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
  }

  function isRevocationControl(target) {
    if (target === null || typeof target !== "object" || Array.isArray(target)) return false;
    try {
      if (Object.getPrototypeOf(target) !== Object.prototype) return false;
      const descriptors = Object.getOwnPropertyDescriptors(target);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.length !== 2 ||
        !keys.includes("protocolVersion") ||
        !keys.includes("type")
      ) return false;
      const protocolVersion = descriptors.protocolVersion;
      const type = descriptors.type;
      return (
        protocolVersion?.enumerable === true &&
        type?.enumerable === true &&
        Object.hasOwn(protocolVersion, "value") &&
        Object.hasOwn(type, "value") &&
        protocolVersion.value === 2 &&
        type.value === "device_revoked"
      );
    } catch {
      return false;
    }
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
    if (stopped || revoked) return local;
    if (sequence > local) {
      await saveMeta(cache, "localAppliedSequence", sequence);
      if (stopped || revoked) return local;
    }
    return Math.max(local, sequence);
  }

  async function catchUp() {
    if (stopped || revoked) return null;
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
        if (stopped || revoked) return null;
        latestSequence = response.sync.latestSequence;
        acknowledgedSequence = response.sync.acknowledgedSequence;
        await ensureLocalBaseline(response.sync.requestedAfterSequence);
        if (stopped || revoked) return null;
        for (const target of response.events) {
          if (stopped || revoked) return null;
          await applyEvent(target);
          if (stopped || revoked) return null;
        }
        if (stopped || revoked) return null;
        if (response.events.length > 0) {
          const last = response.events.at(-1);
          if (stopped || revoked) return null;
          await api.ackSyncEvent(last);
          if (stopped || revoked) return null;
          acknowledgedSequence = last.eventSequence;
          if (stopped || revoked) return null;
          channel?.postMessage({ type: "cache-updated", eventSequence: last.eventSequence });
        }
        if (response.nextAfterSequence === null) break;
        explicitAfter = response.nextAfterSequence;
      }
      if (stopped || revoked) return null;
      const localAppliedSequence = await snapshotSequence();
      if (stopped || revoked) return null;
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
      if (stopped || revoked) return null;
      updateSync({ status: "degraded", error: errorProjection(error) });
      reportError(error);
      throw error;
    }
  }

  async function applyRealtimeEvent(target) {
    if (stopped || revoked) return null;
    await applyEvent(target);
    if (stopped || revoked) return null;
    await api.ackSyncEvent(target);
    if (stopped || revoked) return null;
    const localAppliedSequence = await snapshotSequence();
    if (stopped || revoked) return null;
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
    if (stopped || revoked) return null;
    channel?.postMessage({ type: "cache-updated", eventSequence: target.eventSequence });
  }

  function enqueueRealtime(target) {
    if (stopped || revoked) return lane;
    lane = lane
      .then(() => applyRealtimeEvent(target))
      .catch((error) => {
        if (stopped || revoked) return;
        updateSync({ status: "degraded", error: errorProjection(error) });
        reportError(error);
        scheduleReconnect();
      });
    return lane;
  }

  async function connect() {
    if (stopped || revoked || typeof EventSourceClass !== "function") return null;
    source?.close();
    const afterSequence = await snapshotSequence();
    if (stopped || revoked) return null;
    const eventSource = new EventSourceClass(
      `/api/v1/events/stream?afterSequence=${encodeURIComponent(String(afterSequence))}`
    );
    source = eventSource;
    eventSource.onopen = () => {
      if (stopped || revoked || source !== eventSource) return;
      reconnectAttempt = 0;
      updateSync({ status: "online", error: null });
    };
    eventSource.addEventListener("domain-event", (message) => {
      if (stopped || revoked || source !== eventSource) return;
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
    eventSource.addEventListener("entry-revoked", (message) => {
      let target;
      try { target = JSON.parse(message.data); } catch { return undefined; }
      if (!isRevocationControl(target)) return undefined;
      if (revokeCallbackScheduled) return lane;
      if (stopped || revoked || source !== eventSource) return undefined;
      revoked = true;
      stopped = true;
      revokeCallbackScheduled = true;
      cancelReconnect();
      eventSource.close();
      source = null;
      const beforeRevokeCallback = lane;
      revokeStopBarrier = beforeRevokeCallback.then(
        () => undefined,
        (error) => reportError(error)
      );
      revokeCallbackPromise = Promise.resolve()
        .then(() => onEntryRevoked())
        .catch((error) => reportError(error));
      lane = Promise.all([revokeStopBarrier, revokeCallbackPromise])
        .then(() => undefined);
      return lane;
    });
    eventSource.onerror = () => {
      if (stopped || revoked || source !== eventSource) return;
      eventSource.close();
      updateSync({ status: "offline", error: null });
      scheduleReconnect();
    };
    return eventSource;
  }

  function scheduleReconnect() {
    if (stopped || revoked || reconnectTimer !== null) return;
    const delay = nextReconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      lane = lane
        .then(async () => {
          if (stopped || revoked) return;
          await catchUp();
          if (stopped || revoked) return;
          await connect();
        })
        .catch(() => scheduleReconnect());
    }, delay);
  }

  function start() {
    if (revoked) return lane;
    stopped = false;
    lane = lane.then(async () => {
      if (stopped || revoked) return;
      await catchUp();
      if (stopped || revoked) return;
      await connect();
    });
    return lane;
  }

  function reconnectNow() {
    if (stopped || revoked) return lane;
    if (reconnectTimer !== null) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    source?.close();
    lane = lane
      .then(async () => {
        if (stopped || revoked) return;
        await catchUp();
        if (stopped || revoked) return;
        await connect();
      })
      .catch(() => scheduleReconnect());
    return lane;
  }

  function stop() {
    stopped = true;
    source?.close();
    source = null;
    cancelReconnect();
    channel?.close();
    return revokeCallbackScheduled ? revokeStopBarrier : lane;
  }

  if (channel) {
    channel.onmessage = (message) => {
      if (stopped || revoked) return;
      if (message.data?.type !== "cache-updated") return;
      const sequence = Number(message.data.eventSequence);
      if (!Number.isSafeInteger(sequence)) return;
      updateSync({
        localAppliedSequence: Math.max(
          store.getState().sync?.localAppliedSequence ?? 0,
          sequence
        )
      });
      const beforeCallback = lane;
      let callbackResult;
      try {
        callbackResult = input.onCacheUpdated?.(sequence);
      } catch (error) {
        reportError(error);
        return;
      }
      const callbackPromise = Promise.resolve(callbackResult)
        .catch((error) => reportError(error));
      lane = Promise.all([beforeCallback, callbackPromise])
        .then(() => undefined);
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
