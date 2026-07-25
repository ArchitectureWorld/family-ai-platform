import {
  mergeThreadPage,
  removeOutgoing,
  saveDraft as persistDraft,
  saveOutgoing
} from "./cache.js";

function threadSequence(value) {
  const sequence = Number(value?.threadSequence);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : Number.MAX_SAFE_INTEGER;
}

export function mergeThreadMessages(existing = [], incoming = []) {
  const byRef = new Map();
  for (const message of [...existing, ...incoming]) {
    if (!message || typeof message.messageRef !== "string") continue;
    byRef.set(message.messageRef, message);
  }
  return [...byRef.values()].sort((left, right) => {
    const sequenceDifference = threadSequence(left) - threadSequence(right);
    if (sequenceDifference !== 0) return sequenceDifference;
    return String(left.messageRef).localeCompare(String(right.messageRef));
  });
}

export function createOutgoingMessage(input) {
  return {
    threadRef: input.threadRef,
    clientMessageId: input.clientMessageId,
    occurredAt: input.occurredAt,
    content: structuredClone(input.content),
    status: "sending",
    error: null
  };
}

export function retryPayload(outgoing) {
  return {
    protocolVersion: 1,
    clientMessageId: outgoing.clientMessageId,
    occurredAt: outgoing.occurredAt,
    content: structuredClone(outgoing.requestContent ?? outgoing.content)
  };
}

export function reconcileOutgoing(outgoing = [], authoritativeMessages = []) {
  const acceptedIds = new Set(
    authoritativeMessages
      .map((message) => message?.clientMessageId)
      .filter((value) => typeof value === "string")
  );
  return outgoing.filter((message) =>
    message.status === "failed" || !acceptedIds.has(message.clientMessageId)
  );
}

export function outgoingPresentation(outgoing, authoritativeMessages = []) {
  const accepted = authoritativeMessages.some(
    (message) => message?.clientMessageId === outgoing.clientMessageId
  );
  if (outgoing.status === "failed" && accepted) {
    return {
      kind: "reply_failure",
      text: outgoing.error?.message || "个人助理回复失败，可以重试。",
      accepted: true
    };
  }
  return {
    kind: outgoing.status === "failed" ? "send_failure" : "sending",
    text: outgoing.content?.text ?? "",
    accepted
  };
}

function errorProjection(error) {
  return {
    status: Number(error?.status ?? 0),
    code: typeof error?.code === "string" ? error.code : "GATEWAY_UNAVAILABLE",
    category: typeof error?.category === "string" ? error.category : "internal",
    message: typeof error?.message === "string" ? error.message : "消息发送失败。",
    retryable: Boolean(error?.retryable)
  };
}

function setOutgoing(store, outgoing) {
  store.setState((current) => ({ ...current, outgoing: structuredClone(outgoing) }));
}

function updateDraftState(store, threadRef, text) {
  store.setState((current) => {
    const drafts = { ...(current.drafts ?? {}) };
    if (text.length === 0) delete drafts[threadRef];
    else drafts[threadRef] = text;
    return { ...current, drafts };
  });
}

export function createThreadController(input) {
  const api = input.api;
  const cache = input.cache;
  const store = input.store;
  const isOnline = input.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine);
  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? (() => crypto.randomUUID());

  async function persistReconciledOutgoing(previous, next) {
    const nextIds = new Set(next.map((item) => item.clientMessageId));
    for (const item of previous) {
      if (!nextIds.has(item.clientMessageId)) await removeOutgoing(cache, item.clientMessageId);
    }
  }

  async function applyPage(threadRef, page, mode) {
    await mergeThreadPage(cache, threadRef, page.messages);

    const before = store.getState();
    const existing = before.messagesByThread?.[threadRef] ?? [];
    const messages = mergeThreadMessages(existing, page.messages);
    const outgoing = reconcileOutgoing(before.outgoing ?? [], messages);
    await persistReconciledOutgoing(before.outgoing ?? [], outgoing);

    const pagination = before.paginationByThread ?? {};
    const hasExistingCursor = Object.prototype.hasOwnProperty.call(pagination, threadRef);
    const nextBeforeSequence = mode === "earlier" || !hasExistingCursor
      ? page.nextBeforeSequence ?? null
      : pagination[threadRef];

    store.setState((current) => ({
      ...current,
      messagesByThread: {
        ...(current.messagesByThread ?? {}),
        [threadRef]: messages
      },
      paginationByThread: {
        ...(current.paginationByThread ?? {}),
        [threadRef]: nextBeforeSequence
      },
      outgoing
    }));
    return page;
  }

  async function loadLatest(threadRef, limit = 100) {
    const page = await api.getThreadMessages(threadRef, { limit });
    return applyPage(threadRef, page, "latest");
  }

  async function loadEarlier(threadRef, limit = 100) {
    const beforeSequence = store.getState().paginationByThread?.[threadRef];
    if (beforeSequence === null || beforeSequence === undefined) return null;
    const page = await api.getThreadMessages(threadRef, { beforeSequence, limit });
    return applyPage(threadRef, page, "earlier");
  }

  async function saveDraft(threadRef, text) {
    await persistDraft(cache, threadRef, text);
    updateDraftState(store, threadRef, text);
  }

  async function transmit(outgoing) {
    try {
      await api.sendThreadMessage(outgoing.threadRef, retryPayload(outgoing));
      await loadLatest(outgoing.threadRef);
      await removeOutgoing(cache, outgoing.clientMessageId);
      const remaining = (store.getState().outgoing ?? []).filter(
        (item) => item.clientMessageId !== outgoing.clientMessageId
      );
      setOutgoing(store, remaining);
      await saveDraft(outgoing.threadRef, "");
      return { status: "succeeded" };
    } catch (error) {
      const failed = {
        ...outgoing,
        status: "failed",
        error: errorProjection(error)
      };
      await saveOutgoing(cache, failed);
      const current = store.getState().outgoing ?? [];
      const next = [
        ...current.filter((item) => item.clientMessageId !== failed.clientMessageId),
        failed
      ];
      setOutgoing(store, next);
      return { status: "failed", error: failed.error };
    }
  }

  async function send(threadRef, text, language = undefined) {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("MESSAGE_TEXT_REQUIRED");
    }
    if (!isOnline()) {
      await saveDraft(threadRef, text);
      return { status: "draft" };
    }
    const outgoing = createOutgoingMessage({
      threadRef,
      clientMessageId: `web:${uuid()}`,
      occurredAt: now().toISOString(),
      content: {
        type: "text",
        text,
        ...(language ? { language } : {})
      }
    });
    await saveOutgoing(cache, outgoing);
    setOutgoing(store, [...(store.getState().outgoing ?? []), outgoing]);
    return transmit(outgoing);
  }

  async function retry(clientMessageId) {
    const existing = (store.getState().outgoing ?? []).find(
      (item) => item.clientMessageId === clientMessageId
    );
    if (!existing) throw new Error("OUTGOING_MESSAGE_NOT_FOUND");
    if (!isOnline()) return { status: "draft" };
    const sending = { ...existing, status: "sending", error: null };
    await saveOutgoing(cache, sending);
    setOutgoing(store, (store.getState().outgoing ?? []).map((item) =>
      item.clientMessageId === clientMessageId ? sending : item
    ));
    return transmit(sending);
  }

  return {
    loadLatest,
    loadEarlier,
    refresh: loadLatest,
    saveDraft,
    send,
    retry
  };
}
