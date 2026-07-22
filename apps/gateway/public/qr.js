import { createQrSvg } from "./qr-v10.mjs";

export function qrSvg(value, options = {}) {
  return createQrSvg(value, options);
}
