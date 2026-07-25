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
