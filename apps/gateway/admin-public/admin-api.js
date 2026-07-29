import { adminHeaders, validateAdminCredential } from "./admin-entry.js";

const FAMILY_ROLES = new Set(["adult", "child", "elder"]);
const PERSON_REF = /^person:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const PAIRING_REF = /^pairing:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u;
const AGENT_REF = /^agent:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const THREAD_REF = /^thread:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const WORK_REF = /^work:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const MESSAGE_REF = /^message:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const WORK_STATUSES = new Set([
  "active",
  "paused",
  "waiting_confirmation",
  "completed",
  "archived"
]);
const AGENT_STATUS_LABELS = new Map([
  ["idle", "空闲"],
  ["working", "工作中"],
  ["problem", "有问题"]
]);
const AGENT_PUBLIC_PROBLEMS = new Set([
  null,
  "Agent 尚未配置。",
  "Agent 当前无法连接。",
  "Agent 状态尚未初始化。",
  "Agent 任务执行超时。",
  "Agent 最近一次调用失败。"
]);

export class AdminApiError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "AdminApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AdminApiError(code, 502);
  }
  return value;
}

function responseError(body, status) {
  const code = isRecord(body) && typeof body.code === "string"
    ? body.code
    : isRecord(body) && isRecord(body.error) && typeof body.error.code === "string"
      ? body.error.code
      : "ADMIN_API_FAILED";
  return new AdminApiError(code, status);
}

async function responseJson(response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new AdminApiError("ADMIN_API_RESPONSE_INVALID", 502);
  }
  try {
    return await response.json();
  } catch {
    throw new AdminApiError("ADMIN_API_RESPONSE_INVALID", 502);
  }
}

function requireEntryCredential(credential) {
  if (credential?.kind !== "entry") {
    throw new AdminApiError("ADMIN_ENTRY_REQUIRED", 401);
  }
}

function normalizePersonRef(value) {
  if (typeof value !== "string" || !PERSON_REF.test(value)) {
    throw new AdminApiError("ADMIN_PERSON_REF_INVALID", 400);
  }
  return value;
}

function normalizeAgentRef(value) {
  if (typeof value !== "string" || !AGENT_REF.test(value)) {
    throw new AdminApiError("ADMIN_AGENT_REF_INVALID", 400);
  }
  return value;
}

function normalizeThreadRef(value) {
  if (typeof value !== "string" || !THREAD_REF.test(value)) {
    throw new AdminApiError("ADMIN_THREAD_REF_INVALID", 400);
  }
  return value;
}

function normalizeWorkRef(value) {
  if (typeof value !== "string" || !WORK_REF.test(value)) {
    throw new AdminApiError("ADMIN_WORK_REF_INVALID", 400);
  }
  return value;
}

function normalizedText(value, { code, max }) {
  if (typeof value !== "string") throw new AdminApiError(code, 400);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) {
    throw new AdminApiError(code, 400);
  }
  return normalized;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeWorkspaceSummary(value) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !Array.isArray(value.agents) ||
    value.agents.length > 100
  ) {
    throw new AdminApiError("ADMIN_SYSTEM_WORKSPACE_INVALID", 502);
  }
  const seen = new Set();
  const agents = value.agents.map((agent) => {
    if (
      !isRecord(agent) ||
      !AGENT_REF.test(agent.agentRef ?? "") ||
      typeof agent.displayName !== "string" ||
      agent.displayName.trim() === "" ||
      seen.has(agent.agentRef)
    ) {
      throw new AdminApiError("ADMIN_SYSTEM_WORKSPACE_INVALID", 502);
    }
    seen.add(agent.agentRef);
    return {
      agentRef: agent.agentRef,
      displayName: agent.displayName
    };
  });
  return { protocolVersion: 1, agents };
}

function safeAgentChat(value, expectedAgentRef) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !isRecord(value.chat) ||
    value.chat.agentRef !== expectedAgentRef ||
    !THREAD_REF.test(value.chat.threadRef ?? "")
  ) {
    throw new AdminApiError("ADMIN_SYSTEM_CHAT_INVALID", 502);
  }
  return {
    protocolVersion: 1,
    chat: {
      agentRef: expectedAgentRef,
      threadRef: value.chat.threadRef
    }
  };
}

function safeWorkConversation(value, expectedAgentRef, code) {
  if (
    !isRecord(value) ||
    value.agentRef !== expectedAgentRef ||
    !THREAD_REF.test(value.threadRef ?? "") ||
    !WORK_REF.test(value.workConversationRef ?? "") ||
    typeof value.title !== "string" ||
    value.title.trim() === "" ||
    !WORK_STATUSES.has(value.status)
  ) {
    throw new AdminApiError(code, 502);
  }
  return {
    agentRef: expectedAgentRef,
    threadRef: value.threadRef,
    workConversationRef: value.workConversationRef,
    title: value.title,
    status: value.status
  };
}

function safeWorkList(value, expectedAgentRef) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !Array.isArray(value.conversations) ||
    value.conversations.length > 500
  ) {
    throw new AdminApiError("ADMIN_SYSTEM_WORKS_INVALID", 502);
  }
  return {
    protocolVersion: 1,
    conversations: value.conversations.map((conversation) =>
      safeWorkConversation(
        conversation,
        expectedAgentRef,
        "ADMIN_SYSTEM_WORKS_INVALID"
      ))
  };
}

function safeMessage(value, expectedThreadRef, code) {
  const text = isRecord(value?.content) &&
    value.content.type === "text" &&
    typeof value.content.text === "string"
    ? value.content.text
    : null;
  if (
    !isRecord(value) ||
    !MESSAGE_REF.test(value.messageRef ?? "") ||
    value.threadRef !== expectedThreadRef ||
    !Number.isSafeInteger(value.threadSequence) ||
    value.threadSequence < 1 ||
    text === null ||
    text.length < 1 ||
    text.length > 12000
  ) {
    throw new AdminApiError(code, 502);
  }
  return {
    messageRef: value.messageRef,
    threadRef: expectedThreadRef,
    threadSequence: value.threadSequence,
    content: { type: "text", text }
  };
}

function safeMessageList(value, expectedThreadRef) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    value.threadRef !== expectedThreadRef ||
    !Array.isArray(value.messages) ||
    value.messages.length > 200
  ) {
    throw new AdminApiError("ADMIN_SYSTEM_MESSAGES_INVALID", 502);
  }
  let previousSequence = 0;
  const messages = value.messages.map((message) => {
    const safe = safeMessage(
      message,
      expectedThreadRef,
      "ADMIN_SYSTEM_MESSAGES_INVALID"
    );
    if (safe.threadSequence <= previousSequence) {
      throw new AdminApiError("ADMIN_SYSTEM_MESSAGES_INVALID", 502);
    }
    previousSequence = safe.threadSequence;
    return safe;
  });
  return { protocolVersion: 1, threadRef: expectedThreadRef, messages };
}

function safeProgress(value, expectedWorkRef) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !isRecord(value.snapshot) ||
    value.snapshot.workConversationRef !== expectedWorkRef ||
    !WORK_STATUSES.has(value.snapshot.status)
  ) {
    throw new AdminApiError("ADMIN_SYSTEM_PROGRESS_INVALID", 502);
  }
  const publicFields = [
    "phaseSummary",
    "incompleteTasks",
    "risks",
    "pendingConfirmations",
    "deadlines",
    "updatedAt"
  ];
  const snapshot = {
    workConversationRef: expectedWorkRef,
    status: value.snapshot.status
  };
  for (const field of publicFields) {
    if (Object.hasOwn(value.snapshot, field)) snapshot[field] = value.snapshot[field];
  }
  return { protocolVersion: 1, snapshot };
}

function safeAgentStatus(value, code) {
  if (
    !isRecord(value) ||
    !AGENT_REF.test(value.agentRef ?? "") ||
    typeof value.displayName !== "string" ||
    value.displayName.trim() === "" ||
    AGENT_STATUS_LABELS.get(value.status) !== value.statusLabel
  ) {
    throw new AdminApiError(code, 502);
  }
  return {
    agentRef: value.agentRef,
    displayName: value.displayName,
    status: value.status,
    statusLabel: value.statusLabel
  };
}

function validateAgentCatalog(value) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !Array.isArray(value.agents) ||
    value.agents.length > 500
  ) {
    throw new AdminApiError("ADMIN_AGENTS_INVALID", 502);
  }
  const agents = value.agents.map((agent) => {
    const safe = safeAgentStatus(agent, "ADMIN_AGENTS_INVALID");
    if (
      !Number.isInteger(agent.activeTurnCount) ||
      agent.activeTurnCount < 0 ||
      !validTimestamp(agent.lastCheckedAt) ||
      !AGENT_PUBLIC_PROBLEMS.has(agent.publicProblem)
    ) {
      throw new AdminApiError("ADMIN_AGENTS_INVALID", 502);
    }
    return {
      ...safe,
      activeTurnCount: agent.activeTurnCount,
      lastCheckedAt: agent.lastCheckedAt,
      publicProblem: agent.publicProblem
    };
  });
  return { protocolVersion: 1, agents };
}

function validateMemberMounts(value, personRef) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    value.personRef !== personRef ||
    !Array.isArray(value.mountedAgents) ||
    value.mountedAgents.length > 100 ||
    !(value.defaultAgentRef === null || AGENT_REF.test(value.defaultAgentRef ?? ""))
  ) {
    throw new AdminApiError("ADMIN_AGENT_MOUNTS_INVALID", 502);
  }
  const seen = new Set();
  const mountedAgents = value.mountedAgents.map((mount) => {
    const safe = safeAgentStatus(mount, "ADMIN_AGENT_MOUNTS_INVALID");
    if (typeof mount.isDefault !== "boolean" || seen.has(safe.agentRef)) {
      throw new AdminApiError("ADMIN_AGENT_MOUNTS_INVALID", 502);
    }
    seen.add(safe.agentRef);
    return { ...safe, isDefault: mount.isDefault };
  });
  const defaults = mountedAgents.filter((mount) => mount.isDefault);
  if (
    (value.defaultAgentRef === null && defaults.length !== 0) ||
    (value.defaultAgentRef !== null &&
      (defaults.length !== 1 || defaults[0].agentRef !== value.defaultAgentRef))
  ) {
    throw new AdminApiError("ADMIN_AGENT_MOUNTS_INVALID", 502);
  }
  return {
    protocolVersion: 1,
    personRef,
    defaultAgentRef: value.defaultAgentRef,
    mountedAgents
  };
}

export function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    throw new Error("ADMIN_DISPLAY_NAME_INVALID");
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80) {
    throw new Error("ADMIN_DISPLAY_NAME_INVALID");
  }
  return normalized;
}

export function normalizeFamilyRole(value) {
  if (!FAMILY_ROLES.has(value)) {
    throw new Error("ADMIN_FAMILY_ROLE_INVALID");
  }
  return value;
}

export function createAdminApi({
  fetchImpl = fetch,
  credential = null,
  uuid = () => crypto.randomUUID(),
  now = () => new Date()
} = {}) {
  const validatedCredential = credential === null
    ? null
    : validateAdminCredential(credential);

  async function request(
    path,
    { method = "GET", body, expectedStatus = 200, publicRequest = false } = {}
  ) {
    const headers = {};
    if (!publicRequest) {
      if (validatedCredential === null) {
        throw new AdminApiError("ADMIN_CREDENTIAL_REQUIRED", 401);
      }
      Object.assign(headers, adminHeaders(validatedCredential));
    }
    let serializedBody;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(body);
    }
    const response = await fetchImpl(path, {
      method,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(serializedBody === undefined ? {} : { body: serializedBody })
    });
    const value = await responseJson(response);
    if (response.status !== expectedStatus) throw responseError(value, response.status);
    return value;
  }

  return Object.freeze({
    async adminAccessMode() {
      const value = await request("/api/v1/admin/access-mode", {
        publicRequest: true
      });
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 1 ||
        value.mode !== "preview-auto"
      ) {
        throw new AdminApiError(
          "ADMIN_ACCESS_MODE_RESPONSE_INVALID",
          502
        );
      }
      return { mode: "preview-auto" };
    },

    async openPreviewAccess() {
      const value = await request("/api/v1/admin/preview-access", {
        method: "POST",
        publicRequest: true
      });
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 1 ||
        !isRecord(value.adminCredential)
      ) {
        throw new AdminApiError(
          "ADMIN_PREVIEW_ACCESS_RESPONSE_INVALID",
          502
        );
      }
      try {
        return validateAdminCredential(value.adminCredential);
      } catch {
        throw new AdminApiError(
          "ADMIN_PREVIEW_ACCESS_RESPONSE_INVALID",
          502
        );
      }
    },

    async onboardingStatus() {
      const value = await request("/api/v1/onboarding/status", {
        publicRequest: true
      });
      if (!isRecord(value) || typeof value.initialized !== "boolean") {
        throw new AdminApiError("ADMIN_ONBOARDING_STATUS_INVALID", 502);
      }
      return { initialized: value.initialized };
    },

    async createFamily(input) {
      if (validatedCredential?.kind !== "bootstrap") {
        throw new AdminApiError("ADMIN_BOOTSTRAP_REQUIRED", 401);
      }
      const value = await request("/api/v1/onboarding/family", {
        method: "POST",
        expectedStatus: 201,
        body: {
          familyName: normalizeDisplayName(input?.familyName),
          ownerName: normalizeDisplayName(input?.ownerName),
          deviceName: normalizeDisplayName(input?.deviceName)
        }
      });
      if (
        !isRecord(value) ||
        !isRecord(value.family) ||
        !isRecord(value.owner) ||
        !isRecord(value.device) ||
        !isRecord(value.entries) ||
        !isRecord(value.entries.admin)
      ) {
        throw new AdminApiError("ADMIN_ONBOARDING_RESPONSE_INVALID", 502);
      }
      requiredString(value.family.familyRef, "ADMIN_ONBOARDING_RESPONSE_INVALID");
      requiredString(value.owner.personRef, "ADMIN_ONBOARDING_RESPONSE_INVALID");
      requiredString(value.device.deviceRef, "ADMIN_ONBOARDING_RESPONSE_INVALID");
      const adminCredential = validateAdminCredential({
        kind: "entry",
        entrySessionRef: value.entries.admin.entrySessionRef,
        token: value.entries.admin.token
      });
      return { ...value, adminCredential };
    },

    async context() {
      if (validatedCredential?.kind !== "entry") {
        throw new AdminApiError("ADMIN_ENTRY_REQUIRED", 401);
      }
      const value = await request("/api/v1/portal/context");
      if (
        !isRecord(value) ||
        value.audience !== "family_admin" ||
        !isRecord(value.family) ||
        !isRecord(value.person)
      ) {
        throw new AdminApiError("ADMIN_CONTEXT_INVALID", 502);
      }
      requiredString(value.family.familyRef, "ADMIN_CONTEXT_INVALID");
      requiredString(value.family.displayName, "ADMIN_CONTEXT_INVALID");
      requiredString(value.person.personRef, "ADMIN_CONTEXT_INVALID");
      requiredString(value.person.displayName, "ADMIN_CONTEXT_INVALID");
      return value;
    },

    async persistPreviewCredential() {
      if (validatedCredential?.kind !== "entry") {
        throw new AdminApiError("ADMIN_ENTRY_REQUIRED", 401);
      }
      const value = await request("/api/v1/admin/preview-entry", {
        method: "POST"
      });
      if (!isRecord(value) || value.persisted !== true) {
        throw new AdminApiError("ADMIN_PREVIEW_PERSISTENCE_INVALID", 502);
      }
      return value;
    },

    async members() {
      if (validatedCredential?.kind !== "entry") {
        throw new AdminApiError("ADMIN_ENTRY_REQUIRED", 401);
      }
      const value = await request("/api/v1/admin/members");
      if (!isRecord(value) || !Array.isArray(value.members)) {
        throw new AdminApiError("ADMIN_MEMBERS_INVALID", 502);
      }
      for (const member of value.members) {
        if (!isRecord(member)) throw new AdminApiError("ADMIN_MEMBERS_INVALID", 502);
        requiredString(member.personRef, "ADMIN_MEMBERS_INVALID");
        requiredString(member.displayName, "ADMIN_MEMBERS_INVALID");
      }
      return value;
    },

    async addMember(input) {
      if (validatedCredential?.kind !== "entry") {
        throw new AdminApiError("ADMIN_ENTRY_REQUIRED", 401);
      }
      const value = await request("/api/v1/admin/members", {
        method: "POST",
        expectedStatus: 201,
        body: {
          displayName: normalizeDisplayName(input?.displayName),
          familyRole: normalizeFamilyRole(input?.familyRole)
        }
      });
      if (
        !isRecord(value) ||
        !isRecord(value.member) ||
        typeof value.member.personRef !== "string"
      ) {
        throw new AdminApiError("ADMIN_MEMBER_INVALID", 502);
      }
      return value;
    },

    async agents() {
      requireEntryCredential(validatedCredential);
      return validateAgentCatalog(await request("/api/v1/admin/agents"));
    },

    async memberAgentMounts(personRef) {
      requireEntryCredential(validatedCredential);
      const normalizedPersonRef = normalizePersonRef(personRef);
      const value = await request(
        `/api/v1/admin/members/${encodeURIComponent(normalizedPersonRef)}/agent-mounts`
      );
      return validateMemberMounts(value, normalizedPersonRef);
    },

    async mountAgent(personRef, agentRef) {
      requireEntryCredential(validatedCredential);
      const normalizedPersonRef = normalizePersonRef(personRef);
      const normalizedAgentRef = normalizeAgentRef(agentRef);
      const value = await request(
        `/api/v1/admin/members/${encodeURIComponent(normalizedPersonRef)}/agent-mounts`,
        {
          method: "POST",
          expectedStatus: 201,
          body: { agentRef: normalizedAgentRef }
        }
      );
      return validateMemberMounts(value, normalizedPersonRef);
    },

    async unmountAgent(personRef, agentRef) {
      requireEntryCredential(validatedCredential);
      const normalizedPersonRef = normalizePersonRef(personRef);
      const normalizedAgentRef = normalizeAgentRef(agentRef);
      const value = await request(
        `/api/v1/admin/members/${encodeURIComponent(normalizedPersonRef)}` +
          `/agent-mounts/${encodeURIComponent(normalizedAgentRef)}`,
        { method: "DELETE" }
      );
      return validateMemberMounts(value, normalizedPersonRef);
    },

    async setDefaultAgent(personRef, agentRefOrNull) {
      requireEntryCredential(validatedCredential);
      const normalizedPersonRef = normalizePersonRef(personRef);
      const normalizedAgentRef = agentRefOrNull === null
        ? null
        : normalizeAgentRef(agentRefOrNull);
      const value = await request(
        `/api/v1/admin/members/${encodeURIComponent(normalizedPersonRef)}/default-agent`,
        {
          method: "PUT",
          body: { agentRef: normalizedAgentRef }
        }
      );
      return validateMemberMounts(value, normalizedPersonRef);
    },

    async systemWorkspace() {
      requireEntryCredential(validatedCredential);
      return safeWorkspaceSummary(
        await request("/api/v1/admin/system-workspace")
      );
    },

    async systemAgentChat(agentRef) {
      requireEntryCredential(validatedCredential);
      const normalizedAgentRef = normalizeAgentRef(agentRef);
      const value = await request(
        `/api/v1/admin/system-workspace/agents/` +
          `${encodeURIComponent(normalizedAgentRef)}/chat`
      );
      return safeAgentChat(value, normalizedAgentRef);
    },

    async systemAgentWorkConversations(agentRef) {
      requireEntryCredential(validatedCredential);
      const normalizedAgentRef = normalizeAgentRef(agentRef);
      const value = await request(
        `/api/v1/admin/system-workspace/agents/` +
          `${encodeURIComponent(normalizedAgentRef)}/work-conversations`
      );
      return safeWorkList(value, normalizedAgentRef);
    },

    async createSystemAgentWork(agentRef, input) {
      requireEntryCredential(validatedCredential);
      const normalizedAgentRef = normalizeAgentRef(agentRef);
      const value = await request(
        `/api/v1/admin/system-workspace/agents/` +
          `${encodeURIComponent(normalizedAgentRef)}/work-conversations`,
        {
          method: "POST",
          expectedStatus: 201,
          body: {
            protocolVersion: 1,
            title: normalizedText(input?.title, {
              code: "ADMIN_WORK_TITLE_INVALID",
              max: 120
            }),
            goal: normalizedText(input?.goal, {
              code: "ADMIN_WORK_GOAL_INVALID",
              max: 4000
            })
          }
        }
      );
      if (!isRecord(value) || value.protocolVersion !== 1) {
        throw new AdminApiError("ADMIN_SYSTEM_WORK_INVALID", 502);
      }
      return {
        protocolVersion: 1,
        conversation: safeWorkConversation(
          value.conversation,
          normalizedAgentRef,
          "ADMIN_SYSTEM_WORK_INVALID"
        )
      };
    },

    async systemThreadMessages(threadRef) {
      requireEntryCredential(validatedCredential);
      const normalizedThreadRef = normalizeThreadRef(threadRef);
      const value = await request(
        `/api/v1/admin/system-workspace/threads/` +
          `${encodeURIComponent(normalizedThreadRef)}/messages`
      );
      return safeMessageList(value, normalizedThreadRef);
    },

    async sendSystemThreadMessage(threadRef, text) {
      requireEntryCredential(validatedCredential);
      const normalizedThreadRef = normalizeThreadRef(threadRef);
      const normalizedContent = normalizedText(text, {
        code: "ADMIN_MESSAGE_INVALID",
        max: 12000
      });
      const value = await request(
        `/api/v1/admin/system-workspace/threads/` +
          `${encodeURIComponent(normalizedThreadRef)}/messages`,
        {
          method: "POST",
          expectedStatus: 201,
          body: {
            protocolVersion: 1,
            clientMessageId: `admin-web:${uuid()}`,
            occurredAt: now().toISOString(),
            content: { type: "text", text: normalizedContent }
          }
        }
      );
      if (!isRecord(value) || value.protocolVersion !== 1) {
        throw new AdminApiError("ADMIN_SYSTEM_MESSAGE_INVALID", 502);
      }
      return {
        protocolVersion: 1,
        message: safeMessage(
          value.message,
          normalizedThreadRef,
          "ADMIN_SYSTEM_MESSAGE_INVALID"
        )
      };
    },

    async systemWorkProgress(workRef) {
      requireEntryCredential(validatedCredential);
      const normalizedWorkRef = normalizeWorkRef(workRef);
      const value = await request(
        `/api/v1/admin/system-workspace/work-conversations/` +
          `${encodeURIComponent(normalizedWorkRef)}/progress`
      );
      return safeProgress(value, normalizedWorkRef);
    },

    async createPairing(personRef) {
      if (validatedCredential?.kind !== "entry") {
        throw new AdminApiError("ADMIN_ENTRY_REQUIRED", 401);
      }
      if (typeof personRef !== "string" || !PERSON_REF.test(personRef)) {
        throw new AdminApiError("ADMIN_PERSON_REF_INVALID", 400);
      }
      const value = await request(
        `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
        { method: "POST", expectedStatus: 201 }
      );
      if (
        !isRecord(value) ||
        !isRecord(value.pairing) ||
        !PAIRING_REF.test(value.pairing.pairingRef ?? "") ||
        !PAIRING_CODE.test(value.pairing.code ?? "") ||
        typeof value.pairing.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.pairing.expiresAt)) ||
        value.pairing.status !== "active"
      ) {
        throw new AdminApiError("ADMIN_PAIRING_INVALID", 502);
      }
      return value;
    },

    async revokePairing(pairingRef) {
      if (validatedCredential?.kind !== "entry") {
        throw new AdminApiError("ADMIN_ENTRY_REQUIRED", 401);
      }
      if (typeof pairingRef !== "string" || !PAIRING_REF.test(pairingRef)) {
        throw new AdminApiError("ADMIN_PAIRING_INVALID", 400);
      }
      const value = await request(
        `/api/v1/admin/pairing-codes/${encodeURIComponent(pairingRef)}`,
        { method: "DELETE" }
      );
      if (
        !isRecord(value) ||
        value.pairingRef !== pairingRef ||
        value.status !== "revoked"
      ) {
        throw new AdminApiError("ADMIN_PAIRING_REVOKE_INVALID", 502);
      }
      return value;
    }
  });
}
