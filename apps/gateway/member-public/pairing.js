const PENDING_CLAIM_KEY = "family-ai-member-pending-claim:v2";
const PAIRING_REF_PATTERN = /^pairing:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u;
const DEVICE_CREDENTIAL_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const STANDARD_INSTALLATION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;
const SPECIAL_INSTALLATION_IDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);
const TERMINAL_PAIRING_CODES = new Set([
  "PAIRING_INVALID",
  "PAIRING_EXPIRED",
  "PAIRING_ATTEMPTS_EXCEEDED",
  "PAIRING_CONSUMED",
  "DEVICE_AUTH_INVALID",
  "DEVICE_REVOKED",
  "PAIRING_TARGET_INACTIVE",
]);

function localPairingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function credentialUnavailable() {
  return localPairingError(
    "PAIRING_CREDENTIAL_UNAVAILABLE",
    "当前浏览器无法安全建立入口。",
  );
}

function installationIdIsValid(value) {
  return (
    typeof value === "string" &&
    (STANDARD_INSTALLATION_ID_PATTERN.test(value) ||
      SPECIAL_INSTALLATION_IDS.has(value))
  );
}

function storageOperation(storage, method, ...args) {
  try {
    const operation = storage?.[method];
    if (typeof operation !== "function") {
      throw new TypeError(`SessionStorage.${method} is unavailable`);
    }
    return operation.apply(storage, args);
  } catch {
    throw credentialUnavailable();
  }
}

export function normalizePairingCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function createDeviceCredential(cryptoImpl = globalThis.crypto) {
  if (
    typeof cryptoImpl?.getRandomValues !== "function" ||
    typeof globalThis.btoa !== "function"
  ) {
    throw credentialUnavailable();
  }

  try {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(32));
    const binary = String.fromCharCode(...bytes);
    const credential = globalThis
      .btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    if (!DEVICE_CREDENTIAL_PATTERN.test(credential)) {
      throw credentialUnavailable();
    }
    return credential;
  } catch (error) {
    if (error?.code === "PAIRING_CREDENTIAL_UNAVAILABLE") throw error;
    throw credentialUnavailable();
  }
}

export function preparePendingClaim(input) {
  const hasPairingRef = input.pairingRef !== undefined;
  if (
    (hasPairingRef && !PAIRING_REF_PATTERN.test(input.pairingRef)) ||
    !PAIRING_CODE_PATTERN.test(input.code) ||
    !installationIdIsValid(input.installationId)
  ) {
    throw localPairingError(
      "PAIRING_FRAGMENT_INVALID",
      "配对链接无效，请重新生成。",
    );
  }
  const deviceCredential = createDeviceCredential(input.cryptoImpl);
  const pending = {
    protocolVersion: 2,
    ...(hasPairingRef ? { pairingRef: input.pairingRef } : {}),
    code: input.code,
    installationId: input.installationId,
    deviceCredential,
  };
  storageOperation(
    input.sessionStorage,
    "setItem",
    PENDING_CLAIM_KEY,
    JSON.stringify(pending),
  );
  return pending;
}

export function clearPendingClaim(sessionStorage) {
  storageOperation(sessionStorage, "removeItem", PENDING_CLAIM_KEY);
}

function storedPendingClaimIsValid(value, expectedInstallationId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "code",
    "deviceCredential",
    "installationId",
    ...(Object.hasOwn(value, "pairingRef") ? ["pairingRef"] : []),
    "protocolVersion",
  ].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return (
    value.protocolVersion === 2 &&
    PAIRING_CODE_PATTERN.test(value.code) &&
    installationIdIsValid(value.installationId) &&
    installationIdIsValid(expectedInstallationId) &&
    value.installationId === expectedInstallationId &&
    DEVICE_CREDENTIAL_PATTERN.test(value.deviceCredential) &&
    (!Object.hasOwn(value, "pairingRef") ||
      PAIRING_REF_PATTERN.test(value.pairingRef))
  );
}

export function readPendingClaim(sessionStorage, expectedInstallationId) {
  const stored = storageOperation(sessionStorage, "getItem", PENDING_CLAIM_KEY);
  if (stored === null) return null;

  try {
    const pending = JSON.parse(stored);
    if (storedPendingClaimIsValid(pending, expectedInstallationId)) {
      return pending;
    }
  } catch {
    // Invalid pending material is cleared below.
  }
  clearPendingClaim(sessionStorage);
  return null;
}

export function capturePairingFragment(input) {
  const url = new URL(input.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const hasPairingMaterial =
    fragment.has("pairingRef") || fragment.has("code");
  url.hash = "";
  url.searchParams.delete("pairingRef");
  url.searchParams.delete("code");

  const scrub = () =>
    input.historyRef.replaceState(
      input.historyRef.state,
      "",
      `${url.pathname}${url.search}`,
    );

  if (!hasPairingMaterial) {
    scrub();
    return readPendingClaim(input.sessionStorage, input.installationId);
  }

  const pairingRef = fragment.get("pairingRef");
  const code = normalizePairingCode(fragment.get("code"));
  if (
    fragment.getAll("pairingRef").length !== 1 ||
    fragment.getAll("code").length !== 1 ||
    !PAIRING_REF_PATTERN.test(pairingRef ?? "") ||
    !PAIRING_CODE_PATTERN.test(code)
  ) {
    scrub();
    throw localPairingError(
      "PAIRING_FRAGMENT_INVALID",
      "配对链接无效，请重新生成。",
    );
  }

  const pending = preparePendingClaim({
    pairingRef,
    code,
    installationId: input.installationId,
    sessionStorage: input.sessionStorage,
    cryptoImpl: input.cryptoImpl,
  });
  scrub();
  return pending;
}

export function isTerminalPairingError(error) {
  return TERMINAL_PAIRING_CODES.has(error?.code);
}

export function shouldRetainPendingClaim(error) {
  if (isTerminalPairingError(error)) return false;
  return (
    error instanceof TypeError ||
    error?.category === "timeout" ||
    error?.code === "GATEWAY_UNAVAILABLE" ||
    error?.retryable === true
  );
}
