import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { GatewayMode } from "./app.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

function asset(name: string): string {
  return readFileSync(`${publicDirectory}${name}`, "utf8");
}

export function registerDevelopmentConsole(
  app: FastifyInstance,
  mode: GatewayMode
): void {
  if (mode !== "development") return;

  app.get("/", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/html; charset=utf-8")
      .send(asset("index.html"))
  );
  app.get("/acceptance.js", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/javascript; charset=utf-8")
      .send(asset("acceptance.js"))
  );
  app.get("/acceptance.css", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/css; charset=utf-8")
      .send(asset("acceptance.css"))
  );
}
