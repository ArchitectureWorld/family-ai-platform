import { existsSync, writeFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const { provisionFederationService } = await tsImport(
  "../../src/provisionFederationService.ts",
  import.meta.url
);

const [configurationJson] = process.argv.slice(2);
if (!configurationJson) throw new Error("RACE_WORKER_ARGUMENTS_INVALID");
const configuration = JSON.parse(configurationJson);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

try {
  const result = provisionFederationService(configuration.argv, {
    checkpoint(stage) {
      if (stage !== configuration.targetStage) return;
      writeFileSync(configuration.stageFile, "ready\n", { mode: 0o600 });
      while (!existsSync(configuration.continueFile)) {
        Atomics.wait(sleeper, 0, 0, 10);
      }
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof Error && /^FEDERATION_BOOTSTRAP_[A-Z_]+$/.test(error.message)
    ? error.message
    : "FEDERATION_BOOTSTRAP_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
