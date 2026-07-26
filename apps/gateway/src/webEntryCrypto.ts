import { createHash, hkdfSync } from "node:crypto";

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_SESSION_INFO = Buffer.from(
  "family-ai:web-entry:claim-session:v2",
  "utf8"
);

export function decodeCanonicalWebDeviceCredential(value: string): Buffer {
  if (!CREDENTIAL_PATTERN.test(value)) {
    throw new Error("WEB_DEVICE_CREDENTIAL_INVALID");
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("WEB_DEVICE_CREDENTIAL_INVALID");
  }

  return decoded;
}

export function deriveWebClaimEntryToken(
  deviceCredential: string,
  pairingRef: string
): string {
  const salt = createHash("sha256").update(pairingRef, "utf8").digest();
  return Buffer.from(hkdfSync(
    "sha256",
    decodeCanonicalWebDeviceCredential(deviceCredential),
    salt,
    CLAIM_SESSION_INFO,
    32
  )).toString("base64url");
}
