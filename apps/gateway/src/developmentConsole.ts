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

export function registerDevelopmentConsole(
  app: FastifyInstance,
  mode: GatewayMode
): void {
  if (mode !== "development") return;

  app.get("/", async (_request, reply) =>
    protectedAsset(reply)
      .type("text/html; charset=utf-8")
      .send(asset("index.html"))
  );
  app.get("/acceptance.js", async (_request, reply) =>
    protectedAsset(reply)
      .type("text/javascript; charset=utf-8")
      .send(asset("acceptance.js"))
  );
  app.get("/qr.js", async (_request, reply) =>
    protectedAsset(reply)
      .type("text/javascript; charset=utf-8")
      .send(asset("qr.js"))
  );
  app.get("/qr-v10.mjs", async (_request, reply) =>
    protectedAsset(reply)
      .type("text/javascript; charset=utf-8")
      .send(asset("qr-v10.mjs"))
  );
  app.get("/acceptance.css", async (_request, reply) =>
    protectedAsset(reply)
      .type("text/css; charset=utf-8")
      .send(asset("acceptance.css"))
  );
}
