import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadOrInitializePreviewAdmin,
  previewInternals,
  previewJsonRequest
} from "./member-preview-pair.mjs";

const {
  REF,
  adminHeaders,
  prepareRuntime,
  protectedFile,
  requireExact,
  validatePairingResponse
} = previewInternals;

const AUDIT_DEVICE_CREDENTIAL = `${"S".repeat(42)}A`;
const BUSINESS_MESSAGE = "PREVIEW_AUDIT_PRIVATE_BUSINESS_MESSAGE_BODY";
const COOKIE_NAMES = Object.freeze([
  "family_ai_web_device_ref",
  "family_ai_web_device_credential",
  "family_ai_web_entry_session_ref",
  "family_ai_web_entry_token"
]);
const OUTPUT = Object.freeze({
  PASS: "Preview secret audit: PASS",
  PUBLIC_ERROR: "FAIL PUBLIC_ERROR",
  ORDINARY_JSON: "FAIL ORDINARY_JSON",
  GATEWAY_LOG: "FAIL GATEWAY_LOG",
  PROXY_LOG: "FAIL PROXY_LOG",
  COOKIE: "FAIL COOKIE",
  CLAIM: "FAIL CLAIM",
  INTERNAL: "FAIL INTERNAL"
});

class AuditFailure extends Error {
  constructor(label) {
    super(label);
    this.name = "AuditFailure";
    this.label = label;
  }
}

function auditFail(label) {
  throw new AuditFailure(label);
}

function containsAny(bytes, sentinels) {
  const text = typeof bytes === "string" ? bytes : JSON.stringify(bytes);
  return sentinels.some(value => typeof value === "string" && value !== "" && text.includes(value));
}

function pairingHandoff(origin, pairingRef, code) {
  const handoff = new URL("/member/", origin);
  handoff.hash = new URLSearchParams({ pairingRef, code }).toString();
  return handoff.toString();
}

function setCookieLines(headers) {
  if (typeof headers?.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers?.get?.("set-cookie");
  if (!combined) return [];
  return combined.split(/,\s*(?=family_ai_web_)/u);
}

function parseClaimCookies(headers) {
  const lines = setCookieLines(headers);
  if (lines.length !== 4) auditFail(OUTPUT.COOKIE);
  const cookies = {};
  for (const line of lines) {
    const first = line.split(";", 1)[0];
    const separator = first.indexOf("=");
    if (separator <= 0) auditFail(OUTPUT.COOKIE);
    const name = first.slice(0, separator);
    if (!COOKIE_NAMES.includes(name) || Object.hasOwn(cookies, name)) {
      auditFail(OUTPUT.COOKIE);
    }
    try {
      cookies[name] = decodeURIComponent(first.slice(separator + 1));
    } catch {
      auditFail(OUTPUT.COOKIE);
    }
    if (!/;\s*HttpOnly(?:;|$)/iu.test(line)) auditFail(OUTPUT.COOKIE);
  }
  if (
    Object.keys(cookies).sort().join("\n") !== [...COOKIE_NAMES].sort().join("\n") ||
    cookies.family_ai_web_device_credential !== AUDIT_DEVICE_CREDENTIAL ||
    !REF.device.test(cookies.family_ai_web_device_ref ?? "") ||
    !REF.session.test(cookies.family_ai_web_entry_session_ref ?? "") ||
    !REF.token.test(cookies.family_ai_web_entry_token ?? "")
  ) auditFail(OUTPUT.COOKIE);
  return { cookies, lines };
}

function cookieHeader(cookies) {
  return COOKIE_NAMES
    .map(name => `${name}=${encodeURIComponent(cookies[name])}`)
    .join("; ");
}

async function readLog(path) {
  const bytes = await protectedFile(path, {
    required: false,
    maxBytes: 8 * 1024 * 1024
  });
  return bytes === null ? "" : bytes.toString("utf8");
}

async function bootstrapToken(paths) {
  const bytes = await protectedFile(join(paths.configDir, "device-token"), {
    maxBytes: 128
  });
  const value = bytes.toString("utf8").replace(/\n$/u, "");
  if (!REF.token.test(value)) auditFail(OUTPUT.INTERNAL);
  return value;
}

async function createAuditPairing(origin, admin, fetchImpl) {
  const response = await previewJsonRequest(
    origin,
    `/api/v1/admin/members/${encodeURIComponent(admin.personRef)}/pairing-codes`,
    {
      fetchImpl,
      method: "POST",
      headers: adminHeaders(admin)
    }
  );
  if (response.status !== 201) auditFail(OUTPUT.CLAIM);
  let result;
  try {
    result = validatePairingResponse(response.body);
  } catch {
    auditFail(OUTPUT.CLAIM);
  }
  if (Date.parse(result.pairing.expiresAt) - Date.now() < 240000) {
    auditFail(OUTPUT.CLAIM);
  }
  return result.pairing;
}

async function submitAuditClaim(origin, pairing, installationId, fetchImpl) {
  const response = await previewJsonRequest(
    origin,
    "/api/v1/web-entry/pairing/claim",
    {
      fetchImpl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Family-AI-Web-Request": "1",
        Origin: origin
      },
      body: {
        protocolVersion: 2,
        pairingRef: pairing.pairingRef,
        code: pairing.code,
        installationId,
        deviceCredential: AUDIT_DEVICE_CREDENTIAL,
        device: {
          displayName: "Member Preview Audit Browser",
          browser: "Node",
          operatingSystem: "Linux",
          appVersion: "0.1.0"
        }
      }
    }
  );
  if (response.status !== 204 || response.body !== null) auditFail(OUTPUT.CLAIM);
  return parseClaimCookies(response.headers);
}

async function revokeAuditDevice(origin, cookies, fetchImpl) {
  const response = await previewJsonRequest(
    origin,
    "/api/v1/web-entry/device",
    {
      fetchImpl,
      method: "DELETE",
      headers: {
        Cookie: cookieHeader(cookies),
        "X-Family-AI-Web-Request": "1",
        Origin: origin
      }
    }
  );
  try {
    requireExact(response.body, ["protocolVersion", "status"], OUTPUT.CLAIM);
  } catch {
    auditFail(OUTPUT.CLAIM);
  }
  if (
    response.status !== 200 ||
    response.body.protocolVersion !== 2 ||
    response.body.status !== "revoked"
  ) auditFail(OUTPUT.CLAIM);
}

async function captureOrdinaryJson(origin, cookies, fetchImpl) {
  const response = await previewJsonRequest(origin, "/api/v1/web-entry/context", {
    fetchImpl,
    headers: { Cookie: cookieHeader(cookies) }
  });
  if (response.status !== 200 || response.body === null) {
    auditFail(OUTPUT.ORDINARY_JSON);
  }
  return response.body;
}

async function capturePublicError(origin, sentinels, fetchImpl) {
  const response = await previewJsonRequest(
    origin,
    "/api/v1/web-entry/pairing/claim",
    {
      fetchImpl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Family-AI-Web-Request": "1",
        Origin: origin
      },
      body: {
        protocolVersion: 2,
        hostile: {
          sentinels,
          businessMessage: BUSINESS_MESSAGE
        }
      }
    }
  );
  if (response.status < 400 || response.status > 599) {
    auditFail(OUTPUT.PUBLIC_ERROR);
  }
  requireExact(response.body, ["protocolVersion", "error"], OUTPUT.PUBLIC_ERROR);
  requireExact(
    response.body.error,
    ["code", "category", "message", "retryable", "requestId"],
    OUTPUT.PUBLIC_ERROR
  );
  return response.body;
}

function assertCarrierBoundaries(handoff, cookieLines, sentinels) {
  const [bootstrap, entryToken, credential, pairingCode, fullHandoff] = sentinels;
  if (
    !handoff.includes(pairingCode) ||
    handoff !== fullHandoff ||
    containsAny(handoff, [bootstrap, entryToken, credential])
  ) auditFail(OUTPUT.CLAIM);
  const cookieBytes = cookieLines.join("\n");
  if (
    !cookieBytes.includes(entryToken) ||
    !cookieBytes.includes(credential) ||
    containsAny(cookieBytes, [bootstrap, pairingCode, fullHandoff])
  ) auditFail(OUTPUT.COOKIE);
}

export async function runPreviewSecretAudit(options = {}) {
  const origin = options.origin ?? "http://127.0.0.1:8791";
  const admin = await loadOrInitializePreviewAdmin({
    origin,
    runtimeDir: options.runtimeDir,
    fetchImpl: options.fetchImpl
  });
  const paths = await prepareRuntime(admin.runtimeDir);
  const bootstrap = await bootstrapToken(paths);
  const pairing = await createAuditPairing(origin, admin, options.fetchImpl);
  const handoff = pairingHandoff(origin, pairing.pairingRef, pairing.code);
  const installationId = randomUUID();
  const claim = await submitAuditClaim(
    origin,
    pairing,
    installationId,
    options.fetchImpl
  );
  const entryToken = claim.cookies.family_ai_web_entry_token;
  const sentinels = [
    bootstrap,
    entryToken,
    AUDIT_DEVICE_CREDENTIAL,
    pairing.code,
    handoff
  ];
  assertCarrierBoundaries(handoff, claim.lines, sentinels);

  const ordinaryJson = await captureOrdinaryJson(
    origin,
    claim.cookies,
    options.fetchImpl
  );
  const publicError = await capturePublicError(
    origin,
    sentinels,
    options.fetchImpl
  );
  await revokeAuditDevice(origin, claim.cookies, options.fetchImpl);
  const forbidden = [...sentinels, BUSINESS_MESSAGE];
  if (containsAny(ordinaryJson, forbidden)) auditFail(OUTPUT.ORDINARY_JSON);
  if (containsAny(publicError, forbidden)) auditFail(OUTPUT.PUBLIC_ERROR);

  const gatewayLog = await readLog(join(paths.logsDir, "gateway.log"));
  if (containsAny(gatewayLog, forbidden)) auditFail(OUTPUT.GATEWAY_LOG);
  const proxyLog = await readLog(join(paths.logsDir, "claim-loss-proxy.log"));
  if (containsAny(proxyLog, forbidden)) auditFail(OUTPUT.PROXY_LOG);
  return OUTPUT.PASS;
}

async function main() {
  if (process.argv.length !== 2) auditFail(OUTPUT.INTERNAL);
  const result = await runPreviewSecretAudit();
  process.stdout.write(`${result}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const label = error instanceof AuditFailure ? error.label : OUTPUT.INTERNAL;
    process.stdout.write(`Preview secret audit: ${label}\n`);
    process.exitCode = 1;
  }
}
