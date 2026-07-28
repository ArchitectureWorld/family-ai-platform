import { adminHeaders, validateAdminCredential } from "./admin-entry.js";

const FAMILY_ROLES = new Set(["adult", "child", "elder"]);

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

export function createAdminApi({ fetchImpl = fetch, credential = null } = {}) {
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
    }
  });
}
