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
    content: structuredClone(outgoing.content)
  };
}

export function reconcileOutgoing(outgoing = [], authoritativeMessages = []) {
  const acceptedIds = new Set(
    authoritativeMessages
      .map((message) => message?.clientMessageId)
      .filter((value) => typeof value === "string")
  );
  return outgoing.filter((message) => !acceptedIds.has(message.clientMessageId));
}
