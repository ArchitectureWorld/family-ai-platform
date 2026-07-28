import type {
  ThreadMessage,
  ThreadMessageContent
} from "@family-ai/contracts";

const MAX_HISTORY_MESSAGES = 18;
const MAX_CONTEXT_CHARACTERS = 12_000;

function visibleRole(message: ThreadMessage): "成员" | "助理" | null {
  if (message.actor.type === "person") return "成员";
  if (message.actor.type === "assistant" || message.actor.type === "agent") {
    return "助理";
  }
  return null;
}

function boundedCapsule(lines: readonly string[]): string {
  let result = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const separator = result ? "\n" : "";
    const available = MAX_CONTEXT_CHARACTERS - result.length - separator.length;
    if (available <= 0) break;
    const line = lines[index]!;
    const visible = line.length <= available ? line : line.slice(0, available);
    result = `${visible}${separator}${result}`;
  }
  return result;
}

export function buildProviderContext(input: {
  messages: readonly ThreadMessage[];
  currentMessageRef: string;
  externalSessionRef: string | null;
}): ThreadMessageContent[] {
  const current = input.messages.find(
    (message) => message.messageRef === input.currentMessageRef
  );
  if (!current || current.actor.type !== "person") {
    throw new Error("Current Provider message is not a persisted Person message");
  }

  if (input.externalSessionRef !== null || input.messages.length === 1) {
    return [current.content];
  }

  const previous = input.messages
    .filter((message) => message.messageRef !== current.messageRef)
    .filter((message) => visibleRole(message) !== null)
    .slice(-MAX_HISTORY_MESSAGES);
  const capsuleMessages = [...previous, current];
  const lines = capsuleMessages.map((message) => {
    const role = visibleRole(message);
    if (!role) throw new Error("Provider capsule included a hidden message");
    return `${role}:${message.content.text}`;
  });
  return [{ type: "text", text: boundedCapsule(lines) }];
}
