export const ADMIN_CREDENTIAL_STORAGE_KEY = "family-ai.admin.credential";
export const ADMIN_CLEAN_PATH = "/admin/";

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ENTRY_SESSION_REF =
  /^entry-session:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const DEVICE_REF =
  /^device:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;

function invalidHandoff() {
  throw new Error("ADMIN_HANDOFF_INVALID");
}

function exactFragment(fragment, expectedKeys) {
  if (typeof fragment !== "string" || !fragment.startsWith("#") || fragment.length <= 1) {
    invalidHandoff();
  }
  const params = new URLSearchParams(fragment.slice(1));
  const keys = [...params.keys()];
  if (
    keys.length !== expectedKeys.length ||
    new Set(keys).size !== keys.length ||
    expectedKeys.some(key => !params.has(key)) ||
    keys.some(key => !expectedKeys.includes(key))
  ) {
    invalidHandoff();
  }
  return params;
}

export function validateAdminCredential(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidHandoff();
  }
  const keys = Object.keys(value).sort();
  if (value.kind === "entry") {
    if (
      keys.join("\0") !== "entrySessionRef\0kind\0token" ||
      !ENTRY_SESSION_REF.test(value.entrySessionRef ?? "") ||
      !TOKEN.test(value.token ?? "")
    ) {
      invalidHandoff();
    }
    return {
      kind: "entry",
      entrySessionRef: value.entrySessionRef,
      token: value.token
    };
  }
  if (value.kind === "bootstrap") {
    if (
      keys.join("\0") !== "deviceRef\0kind\0token" ||
      !DEVICE_REF.test(value.deviceRef ?? "") ||
      !TOKEN.test(value.token ?? "")
    ) {
      invalidHandoff();
    }
    return {
      kind: "bootstrap",
      deviceRef: value.deviceRef,
      token: value.token
    };
  }
  invalidHandoff();
}

export function captureAdminHandoff(fragment) {
  if (fragment.includes("entrySessionRef") || fragment.includes("token=")) {
    const params = exactFragment(fragment, ["entrySessionRef", "token"]);
    return validateAdminCredential({
      kind: "entry",
      entrySessionRef: params.get("entrySessionRef"),
      token: params.get("token")
    });
  }
  const params = exactFragment(fragment, ["deviceRef", "bootstrapToken"]);
  return validateAdminCredential({
    kind: "bootstrap",
    deviceRef: params.get("deviceRef"),
    token: params.get("bootstrapToken")
  });
}

export function adminHeaders(credential) {
  const validated = validateAdminCredential(credential);
  if (validated.kind === "entry") {
    return {
      Authorization: `Bearer ${validated.token}`,
      "X-Entry-Session-Ref": validated.entrySessionRef
    };
  }
  return {
    Authorization: `Bearer ${validated.token}`,
    "X-Device-Ref": validated.deviceRef
  };
}

export function writeStoredAdminCredential(storage, credential) {
  const validated = validateAdminCredential(credential);
  storage.setItem(ADMIN_CREDENTIAL_STORAGE_KEY, JSON.stringify(validated));
}

export function readStoredAdminCredential(storage) {
  const serialized = storage.getItem(ADMIN_CREDENTIAL_STORAGE_KEY);
  if (serialized === null) return null;
  try {
    return validateAdminCredential(JSON.parse(serialized));
  } catch {
    storage.removeItem(ADMIN_CREDENTIAL_STORAGE_KEY);
    return null;
  }
}

export function clearStoredAdminCredential(storage) {
  storage.removeItem(ADMIN_CREDENTIAL_STORAGE_KEY);
}
