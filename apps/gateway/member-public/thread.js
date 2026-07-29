import {
  enqueueOutgoingMessage,
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
    ...(input.agentRef ? { agentRef: input.agentRef } : {}),
    occurredAt: input.occurredAt,
    content: structuredClone(input.content),
    attachments: structuredClone(input.attachments ?? []),
    attachmentRefs: [...(input.attachmentRefs ?? [])],
    status: "sending",
    error: null
  };
}

export function retryPayload(outgoing) {
  return {
    protocolVersion: 1,
    clientMessageId: outgoing.clientMessageId,
    occurredAt: outgoing.occurredAt,
    content: structuredClone(outgoing.requestContent ?? outgoing.content),
    attachmentRefs: [...(outgoing.attachmentRefs ?? [])]
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

function clearEnqueuedProjection(store, threadRef, attachmentRefs) {
  const removed = new Set(attachmentRefs);
  store.setState((current) => {
    const drafts = { ...(current.drafts ?? {}) };
    delete drafts[threadRef];
    return {
      ...current,
      drafts,
      attachmentDrafts: (current.attachmentDrafts ?? []).filter(
        (draft) => !removed.has(draft.attachmentRef)
      )
    };
  });
}

export function createThreadController(input) {
  const api = input.api;
  const cache = input.cache;
  const store = input.store;
  const isOnline = input.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine);
  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? (() => crypto.randomUUID());

  function selectedAgentRef() {
    const state = store.getState();
    if (!Object.prototype.hasOwnProperty.call(state, "currentAgentRef")) {
      return state.context?.agent?.agentRef ?? "agent:personal-assistant";
    }
    const agentRef = state.currentAgentRef;
    if (!agentRef) throw new Error("AGENT_SELECTION_REQUIRED");
    return agentRef;
  }

  function assertStillSelected(agentRef) {
    const state = store.getState();
    if (!Object.prototype.hasOwnProperty.call(state, "currentAgentRef")) {
      return;
    }
    if (state.currentAgentRef !== agentRef) {
      const error = new Error("Agent selection changed.");
      error.code = "AGENT_SELECTION_CHANGED";
      throw error;
    }
  }

  function projectionIsSelected(agentRef) {
    const state = store.getState();
    if (!Object.prototype.hasOwnProperty.call(state, "currentAgentRef")) {
      return true;
    }
    return state.currentAgentRef === agentRef;
  }

  async function persistReconciledOutgoing(previous, next) {
    const nextIds = new Set(next.map((item) => item.clientMessageId));
    for (const item of previous) {
      if (!nextIds.has(item.clientMessageId)) await removeOutgoing(cache, item.clientMessageId);
    }
  }

  async function applyPage(agentRef, threadRef, page, mode) {
    assertStillSelected(agentRef);
    await mergeThreadPage(cache, threadRef, page.messages);
    assertStillSelected(agentRef);

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
    const agentRef = selectedAgentRef();
    const page = await api.getThreadMessages(threadRef, { limit });
    return applyPage(agentRef, threadRef, page, "latest");
  }

  async function loadEarlier(threadRef, limit = 100) {
    const agentRef = selectedAgentRef();
    const beforeSequence = store.getState().paginationByThread?.[threadRef];
    if (beforeSequence === null || beforeSequence === undefined) return null;
    const page = await api.getThreadMessages(threadRef, { beforeSequence, limit });
    return applyPage(agentRef, threadRef, page, "earlier");
  }

  async function saveDraft(threadRef, text) {
    const agentRef = selectedAgentRef();
    await persistDraft(cache, threadRef, text, agentRef);
    assertStillSelected(agentRef);
    updateDraftState(store, threadRef, text);
  }

  async function applyTransmissionPage(outgoing, page) {
    await mergeThreadPage(cache, outgoing.threadRef, page.messages);
    await removeOutgoing(cache, outgoing.clientMessageId);
    if (!projectionIsSelected(outgoing.agentRef)) return page;
    const current = store.getState();
    const messages = mergeThreadMessages(
      current.messagesByThread?.[outgoing.threadRef] ?? [],
      page.messages
    );
    store.setState((state) => ({
      ...state,
      messagesByThread: {
        ...(state.messagesByThread ?? {}),
        [outgoing.threadRef]: messages
      },
      outgoing: (state.outgoing ?? []).filter(
        (item) => item.clientMessageId !== outgoing.clientMessageId
      )
    }));
    return page;
  }

  async function transmit(outgoing) {
    try {
      await api.sendThreadMessage(outgoing.threadRef, retryPayload(outgoing));
      const page = await api.getThreadMessages(outgoing.threadRef, {
        limit: 100
      });
      await applyTransmissionPage(outgoing, page);
      return { status: "succeeded" };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const failed = {
        ...outgoing,
        status: "failed",
        error: errorProjection(error)
      };
      await saveOutgoing(cache, failed);
      if (projectionIsSelected(outgoing.agentRef)) {
        const current = store.getState().outgoing ?? [];
        const next = [
          ...current.filter(
            (item) => item.clientMessageId !== failed.clientMessageId
          ),
          failed
        ];
        setOutgoing(store, next);
      }
      return { status: "failed", error: failed.error };
    }
  }

  async function enqueue(
    threadRef,
    text,
    attachments = [],
    language = undefined
  ) {
    if (
      typeof text !== "string" ||
      (text.trim().length === 0 && attachments.length === 0)
    ) {
      throw new Error("MESSAGE_TEXT_REQUIRED");
    }
    if (!isOnline()) {
      await saveDraft(threadRef, text);
      return { status: "draft" };
    }
    const agentRef = selectedAgentRef();
    for (const attachment of attachments) {
      if (
        attachment.agentRef !== agentRef ||
        attachment.threadRef !== threadRef ||
        attachment.serverState !== "ready" ||
        !attachment.publicMetadata
      ) {
        const error = new Error("Attachment tray changed before enqueue.");
        error.code = "ATTACHMENT_DRAFT_INVALID";
        throw error;
      }
    }
    const publicAttachments = attachments.map(
      (attachment) => structuredClone(attachment.publicMetadata)
    );
    const attachmentRefs = publicAttachments.map(
      (attachment) => attachment.attachmentRef
    );
    const outgoing = createOutgoingMessage({
      threadRef,
      agentRef,
      clientMessageId: `web:${uuid()}`,
      occurredAt: now().toISOString(),
      content: {
        type: "text",
        text,
        ...(language ? { language } : {})
      },
      attachments: publicAttachments,
      attachmentRefs
    });
    await enqueueOutgoingMessage(cache, {
      outgoing,
      attachmentRefs
    });
    if (projectionIsSelected(agentRef)) {
      clearEnqueuedProjection(store, threadRef, attachmentRefs);
      setOutgoing(store, [...(store.getState().outgoing ?? []), outgoing]);
    }
    const transmission = transmit(outgoing);
    return {
      status: "queued",
      outgoing: structuredClone(outgoing),
      transmission
    };
  }

  async function send(threadRef, text, language = undefined) {
    return enqueue(threadRef, text, [], language);
  }

  async function retry(clientMessageId) {
    const agentRef = selectedAgentRef();
    const existing = (store.getState().outgoing ?? []).find(
      (item) => item.clientMessageId === clientMessageId
    );
    if (!existing) throw new Error("OUTGOING_MESSAGE_NOT_FOUND");
    if (existing.agentRef && existing.agentRef !== agentRef) {
      throw new Error("OUTGOING_AGENT_MISMATCH");
    }
    if (!isOnline()) return { status: "draft" };
    const sending = { ...existing, status: "sending", error: null };
    await saveOutgoing(cache, sending);
    if (projectionIsSelected(agentRef)) {
      setOutgoing(store, (store.getState().outgoing ?? []).map((item) =>
        item.clientMessageId === clientMessageId ? sending : item
      ));
    }
    const transmission = transmit(sending);
    return {
      status: "queued",
      outgoing: structuredClone(sending),
      transmission
    };
  }

  return {
    loadLatest,
    loadEarlier,
    refresh: loadLatest,
    saveDraft,
    enqueue,
    send,
    retry
  };
}
