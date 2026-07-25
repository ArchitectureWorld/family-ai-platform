import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

const memberDirectory = fileURLToPath(new URL("../member-public/", import.meta.url));
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

function asset(name: string): string {
  return readFileSync(`${memberDirectory}${name}`, "utf8");
}

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
  contentType: string
): void {
  app.get(path, async (_request, reply) =>
    protectedAsset(reply)
      .type(contentType)
      .send(asset(filename))
  );
}

export function registerMemberWeb(app: FastifyInstance): void {
  app.get("/", async (_request, reply) => reply.redirect("/member/"));
  app.get("/member", async (_request, reply) => reply.redirect("/member/"));
  registerTextAsset(app, "/member/", "index.html", "text/html; charset=utf-8");
  registerTextAsset(
    app,
    "/member/assets/entry.js",
    "entry.js",
    "text/javascript; charset=utf-8"
  );
  registerTextAsset(
    app,
    "/member/assets/member.css",
    "member.css",
    "text/css; charset=utf-8"
  );
}
