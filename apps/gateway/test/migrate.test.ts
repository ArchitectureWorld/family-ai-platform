import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openGatewayDatabase } from "../src/database.js";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const cli = join(root, "apps/gateway/src/migrate.ts");

describe("Gateway migration-only CLI", () => {
  let directory = "";

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const run = (databasePath: string) => spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--database", databasePath],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" },
      timeout: 20_000
    }
  );

  it.each(["fresh", "v14"])(
    "migrates a %s database to exact V15 and replays idempotently",
    (fixture) => {
      directory = mkdtempSync(join(tmpdir(), `family-ai-migrate-${fixture}-`));
      const databasePath = join(directory, "gateway.sqlite");
      if (fixture === "v14") {
        openGatewayDatabase(databasePath, { migrationLimit: 14 }).close();
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = run(databasePath);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(
          '{"schemaVersion":15,"quickCheck":"ok","foreignKeyViolations":0}\n'
        );
      }
      const database = openGatewayDatabase(databasePath);
      expect(database.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations"
      ).get()).toEqual({ version: 15 });
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
      expect(database.pragma("foreign_key_check")).toEqual([]);
      database.close();
    },
    30_000
  );
});
