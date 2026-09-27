import type { FastifyInstance } from "fastify";
import { requireEntryRequest, type EntrySessionAuthenticator } from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";
import { readSpeakerMonitor, type SpeakerMonitorConfig } from "./speakerMonitor.js";

export function registerSpeakerMonitorRoutes(app: FastifyInstance, input: {
  entryAuthenticator: EntrySessionAuthenticator;
  config?: SpeakerMonitorConfig;
  now: () => Date;
}): void {
  app.get("/api/v1/admin/speakers", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    if (input.config && input.config.familyRef !== context.family.familyRef) {
      throw new GatewayDomainError("SPEAKER_MONITOR_FORBIDDEN", 403, "permission", false, "当前家庭无权查看此音箱状态。");
    }
    return readSpeakerMonitor(input.config, input.now());
  });
}
