import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { GatewayMode } from "./app.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

function asset(name: string): string {
  return readFileSync(`${publicDirectory}${name}`, "utf8");
}

function protectedAsset(reply: FastifyReply): FastifyReply {
  return reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", contentSecurityPolicy)
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY");
}

function registerTextAsset(
  app: FastifyInstance,
  path: string,
  filename: string,
  contentType: string
): void {
  app.get(path, async (_request, reply) =>
    protectedAsset(reply)
      .type(contentType)
      .send(asset(filename))
  );
}

export function registerDevelopmentConsole(
  app: FastifyInstance,
  mode: GatewayMode
): void {
  if (mode !== "development") return;

  registerTextAsset(app, "/", "index.html", "text/html; charset=utf-8");
  registerTextAsset(app, "/acceptance.js", "acceptance.js", "text/javascript; charset=utf-8");
  registerTextAsset(app, "/mobileAcceptance.js", "mobileAcceptance.js", "text/javascript; charset=utf-8");
  registerTextAsset(app, "/qr.js", "qr.js", "text/javascript; charset=utf-8");
  registerTextAsset(app, "/qr-v10.mjs", "qr-v10.mjs", "text/javascript; charset=utf-8");
  registerTextAsset(app, "/acceptance.css", "acceptance.css", "text/css; charset=utf-8");
  registerTextAsset(app, "/mobile-acceptance.css", "mobile-acceptance.css", "text/css; charset=utf-8");
}
