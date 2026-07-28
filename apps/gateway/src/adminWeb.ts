import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

type AdminWebMode = "test" | "development" | "production";

const adminDirectory = fileURLToPath(new URL("../admin-public/", import.meta.url));
const qrDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join("; ");

function protectedAsset(reply: FastifyReply): FastifyReply {
  return reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", contentSecurityPolicy)
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function registerTextAsset(
  app: FastifyInstance,
  path: string,
  filename: string,
  contentType: string,
  directory = adminDirectory
): void {
  app.get(path, async (_request, reply) =>
    protectedAsset(reply)
      .type(contentType)
      .send(readFileSync(`${directory}${filename}`, "utf8"))
  );
}

export function registerAdminWeb(app: FastifyInstance, mode: AdminWebMode): void {
  if (mode !== "development") return;

  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  registerTextAsset(app, "/admin/", "index.html", "text/html; charset=utf-8");
  registerTextAsset(
    app,
    "/admin/assets/admin.css",
    "admin.css",
    "text/css; charset=utf-8"
  );
  registerTextAsset(
    app,
    "/admin/assets/admin.js",
    "admin.js",
    "text/javascript; charset=utf-8"
  );
  registerTextAsset(
    app,
    "/admin/assets/admin-entry.js",
    "admin-entry.js",
    "text/javascript; charset=utf-8"
  );
  registerTextAsset(
    app,
    "/admin/assets/admin-api.js",
    "admin-api.js",
    "text/javascript; charset=utf-8"
  );
  registerTextAsset(
    app,
    "/admin/assets/admin-agents.js",
    "admin-agents.js",
    "text/javascript; charset=utf-8"
  );
  registerTextAsset(
    app,
    "/admin/assets/admin-pairing.js",
    "admin-pairing.js",
    "text/javascript; charset=utf-8"
  );
  registerTextAsset(
    app,
    "/admin/assets/qr.js",
    "qr.js",
    "text/javascript; charset=utf-8",
    qrDirectory
  );
  registerTextAsset(
    app,
    "/admin/assets/qr-v10.mjs",
    "qr-v10.mjs",
    "text/javascript; charset=utf-8",
    qrDirectory
  );
}
