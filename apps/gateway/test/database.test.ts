import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openGatewayDatabase,
  runDevelopmentBootstrap,
  type GatewayDatabase
} from "../src/database.js";

const bootstrap = {
  memberRef: "member:test",
  memberDisplayName: "测试成员",
  deviceRef: "device:test",
  deviceDisplayName: "测试设备",
  deviceToken: "initial-device-token-with-enough-length",
  agentRef: "agent:personal-assistant",
  agentDisplayName: "个人助理",
  providerProfileRef: "provider-profile:fake-local"
};

describe("gateway database", () => {
  let directory = "";
  let db: GatewayDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("applies numbered migrations once and keeps foreign keys valid", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-db-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    expect(
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual([{ version: 1 }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    db = openGatewayDatabase(databasePath);
    expect(
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual([{ version: 1 }]);
  });

  it("bootstraps missing development records without overwriting operational state", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-bootstrap-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    runDevelopmentBootstrap(db, bootstrap);

    const original = db
      .prepare("SELECT token_hash, status FROM devices WHERE device_ref = ?")
      .get(bootstrap.deviceRef) as { token_hash: string; status: string };
    db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_ref = ?").run(
      new Date().toISOString(),
      bootstrap.deviceRef
    );

    runDevelopmentBootstrap(db, {
      ...bootstrap,
      deviceToken: "different-device-token-with-enough-length",
      deviceDisplayName: "不应覆盖的名称"
    });

    const after = db
      .prepare("SELECT token_hash, status, display_name FROM devices WHERE device_ref = ?")
      .get(bootstrap.deviceRef) as {
      token_hash: string;
      status: string;
      display_name: string;
    };
    expect(after.token_hash).toBe(original.token_hash);
    expect(after.status).toBe("revoked");
    expect(after.display_name).toBe(bootstrap.deviceDisplayName);
  });
});
