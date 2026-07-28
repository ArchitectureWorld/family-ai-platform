function mountedRefs(context) {
  return new Set(
    (context?.mountedAgents ?? [])
      .map((agent) => agent?.agentRef)
      .filter((agentRef) => typeof agentRef === "string" && agentRef.length > 0)
  );
}

export function chooseInitialAgent(context, savedAgentRef) {
  if (!Array.isArray(context?.mountedAgents)) {
    return {
      kind: "selected",
      agentRef: context?.agent?.agentRef ?? "agent:personal-assistant"
    };
  }

  const refs = mountedRefs(context);
  if (refs.size === 0) return { kind: "unconfigured" };

  if (typeof savedAgentRef === "string" && refs.has(savedAgentRef)) {
    return { kind: "selected", agentRef: savedAgentRef };
  }

  if (
    typeof context?.defaultAgentRef === "string" &&
    refs.has(context.defaultAgentRef)
  ) {
    return { kind: "selected", agentRef: context.defaultAgentRef };
  }

  return { kind: "selection_required" };
}

export function isMountedAgent(context, agentRef) {
  if (!Array.isArray(context?.mountedAgents)) {
    return agentRef === (
      context?.agent?.agentRef ?? "agent:personal-assistant"
    );
  }
  return mountedRefs(context).has(agentRef);
}
