const PAIRING_REF = /^pairing:[a-z0-9][a-z0-9._:-]{1,126}$/u;
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u;

function isPrivateIpv4(value) {
  const octets = value.split(".");
  if (
    octets.length !== 4 ||
    octets.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part))
  ) {
    return false;
  }
  const numbers = octets.map(Number);
  if (numbers.some(number => number < 0 || number > 255)) return false;
  return numbers[0] === 10 ||
    (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) ||
    (numbers[0] === 192 && numbers[1] === 168);
}

function validatePairing(pairing) {
  if (
    pairing === null ||
    typeof pairing !== "object" ||
    Array.isArray(pairing) ||
    !PAIRING_REF.test(pairing.pairingRef ?? "") ||
    !PAIRING_CODE.test(pairing.code ?? "") ||
    typeof pairing.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(pairing.expiresAt))
  ) {
    throw new Error("ADMIN_PAIRING_INVALID");
  }
  return pairing;
}

export function memberHandoffUrl(origin, pairing) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("ADMIN_PAIRING_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "9443" ||
    !isPrivateIpv4(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("ADMIN_PAIRING_ORIGIN_INVALID");
  }
  const validated = validatePairing(pairing);
  const fragment = new URLSearchParams({
    pairingRef: validated.pairingRef,
    code: validated.code
  });
  return `${parsed.origin}/member/#${fragment.toString()}`;
}

export function pairingCountdown(expiresAt, now = Date.now()) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) {
    throw new Error("ADMIN_PAIRING_EXPIRY_INVALID");
  }
  const remainingSeconds = Math.max(0, Math.ceil((expiry - now) / 1000));
  if (remainingSeconds === 0) {
    return { expired: true, remainingSeconds: 0, label: "已过期" };
  }
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  return {
    expired: false,
    remainingSeconds,
    label: `${minutes}:${seconds}`
  };
}

export function createPairingDismissalGuard({
  pairing,
  revokePairing,
  now = Date.now
}) {
  const validated = validatePairing(pairing);
  if (typeof revokePairing !== "function" || typeof now !== "function") {
    throw new Error("ADMIN_PAIRING_DISMISSAL_INVALID");
  }
  let armed = true;
  return Object.freeze({
    disarm() {
      armed = false;
    },
    async revoke() {
      if (!armed) return false;
      armed = false;
      if (pairingCountdown(validated.expiresAt, now()).expired) return false;
      try {
        await revokePairing(validated.pairingRef);
        return true;
      } catch {
        return false;
      }
    }
  });
}

export function pairingQrSvg(url, encoder) {
  if (typeof encoder !== "function") {
    throw new Error("ADMIN_PAIRING_QR_ENCODER_INVALID");
  }
  return encoder(url, { title: "Family AI Member Web pairing" });
}
