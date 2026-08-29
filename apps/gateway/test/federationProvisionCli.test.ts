import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openGatewayDatabase } from "../src/database.js";
import { readProtectedFederationCredential } from "../src/provisionFederationService.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "apps/gateway/src/provisionFederationService.ts");
const token = "Canvas-Service-Credential-0001";
const secondToken = "Canvas-Service-Credential-0002";

let directory = "";
let databasePath = "";
let credentialPath = "";

function writeCredential(
  name: string,
  value: string | Buffer,
  mode = 0o600
): string {
  const path = join(directory, name);
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
  return path;
}

function argumentsFor(input: {
  serviceRef?: string;
  product?: string;
  credential?: string;
  database?: string;
} = {}): string[] {
  return [
    "--service-ref", input.serviceRef ?? "service:canvas",
    "--product", input.product ?? "canvas",
    "--credential-file", input.credential ?? credentialPath,
    "--database", input.database ?? databasePath
  ];
}

function runCli(
  args = argumentsFor()
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env }
  });
}

function runPackageCli(args = argumentsFor()): SpawnSyncReturns<string> {
  return spawnSync("npm", [
    "--silent",
    "run",
    "provision:federation-service",
    "--",
    ...args
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env }
  });
}

function expectFixedFailure(
  result: SpawnSyncReturns<string>,
  code: string,
  secrets: readonly string[] = []
): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`${code}\n`);
  for (const secret of secrets) {
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  }
}

function inspectServices(): Array<Record<string, unknown>> {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true
  });
  try {
    return database.prepare(
      `SELECT service_ref, product, token_hash, status, revoked_at
       FROM federation_services ORDER BY service_ref`
    ).all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "family-federation-bootstrap-"));
  databasePath = join(directory, "gateway.sqlite");
  const database = openGatewayDatabase(databasePath);
  database.close();
  credentialPath = writeCredential("canvas.credential", token);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("protected federation service bootstrap CLI", () => {
  it("provisions Canvas from an existing V14 database without exposing credential material", () => {
    const result = runPackageCli();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      '{"status":"ready","serviceRef":"service:canvas","product":"canvas"}\n'
    );
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).not.toContain(token);
    expect(combined).not.toContain(credentialPath);
    expect(combined).not.toContain(databasePath);
    expect(combined).not.toContain(
      createHash("sha256").update(token, "utf8").digest("hex")
    );
    expect(inspectServices()).toEqual([
      {
        service_ref: "service:canvas",
        product: "canvas",
        token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
        status: "active",
        revoked_at: null
      }
    ]);
  });

  it("is idempotent across process restart and provisions ME independently", () => {
    const first = runCli();
    const replay = runCli();
    const meCredential = writeCredential("me.credential", secondToken);
    const me = runCli(argumentsFor({
      serviceRef: "service:me",
      product: "me",
      credential: meCredential
    }));

    for (const result of [first, replay, me]) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(replay.stdout).toBe(first.stdout);
    expect(me.stdout).toBe(
      '{"status":"ready","serviceRef":"service:me","product":"me"}\n'
    );
    expect(inspectServices()).toHaveLength(2);
  });

  it.each([
    {
      label: "token drift",
      args: () => argumentsFor({
        credential: writeCredential("token-drift.credential", secondToken)
      })
    },
    {
      label: "product drift",
      args: () => argumentsFor({ product: "me" })
    },
    {
      label: "service-ref drift with the same token",
      args: () => argumentsFor({ serviceRef: "service:canvas-other" })
    }
  ])("rejects $label without changing the existing service", ({ args }) => {
    expect(runCli().status).toBe(0);
    const result = runCli(args());

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_SERVICE_CONFLICT", [
      token,
      secondToken,
      credentialPath,
      databasePath
    ]);
    expect(inspectServices()).toHaveLength(1);
  });

  it("fails closed when the exact service was revoked", () => {
    expect(runCli().status).toBe(0);
    const database = new Database(databasePath, { fileMustExist: true });
    database.prepare(
      `UPDATE federation_services
       SET status = 'revoked', revoked_at = '2026-08-29T00:00:00.000Z'
       WHERE service_ref = 'service:canvas'`
    ).run();
    database.close();

    const result = runCli();

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_SERVICE_REVOKED", [
      token,
      credentialPath,
      databasePath
    ]);
    expect(inspectServices()[0]).toMatchObject({
      service_ref: "service:canvas",
      status: "revoked"
    });
  });

  it.each([
    ["short", "x".repeat(15)],
    ["large", "x".repeat(4097)],
    ["space", ` ${token}`],
    ["newline", `${token}\n`],
    ["crlf", `${token}\r\n`],
    ["nul", Buffer.from(`${token}\0`, "utf8")],
    ["unicode", `${token}密`]
  ])("rejects %s credential bytes without trimming", (name, value) => {
    const hostile = writeCredential(`${name}.credential`, value);
    const result = runCli(argumentsFor({ credential: hostile }));

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID", [
      token,
      hostile,
      databasePath
    ]);
    expect(inspectServices()).toEqual([]);
  });

  it("accepts exact credential length boundaries without normalization", () => {
    const minimum = writeCredential("minimum.credential", "A".repeat(16));
    const maximum = writeCredential("maximum.credential", "Z".repeat(4096));

    expect(runCli(argumentsFor({ credential: minimum })).status).toBe(0);
    expect(runCli(argumentsFor({
      serviceRef: "service:me",
      product: "me",
      credential: maximum
    })).status).toBe(0);
    expect(inspectServices()).toHaveLength(2);
  });

  it("rejects symlink, hard-link, mode and non-regular credentials", () => {
    const symlink = join(directory, "credential-symlink");
    symlinkSync(credentialPath, symlink);
    const hardLink = join(directory, "credential-hard-link");
    linkSync(credentialPath, hardLink);
    const loose = writeCredential("credential-loose", secondToken, 0o644);
    const credentialDirectory = join(directory, "credential-directory");
    mkdirSync(credentialDirectory);

    for (const hostile of [symlink, credentialPath, hardLink, loose, credentialDirectory]) {
      const result = runCli(argumentsFor({ credential: hostile }));
      expectFixedFailure(result, "FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID", [
        token,
        secondToken,
        hostile,
        databasePath
      ]);
    }
    expect(inspectServices()).toEqual([]);
  });

  it("rejects a credential not owned by the current process uid", () => {
    const currentUid = process.getuid();
    vi.spyOn(process, "getuid").mockReturnValue(currentUid + 1);

    expect(() => readProtectedFederationCredential(credentialPath)).toThrow(
      "FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID"
    );
  });

  it("rejects relative credential and database paths before opening them", () => {
    const relativeCredential = relative(root, credentialPath);
    const relativeDatabase = relative(root, databasePath);

    expectFixedFailure(
      runCli(argumentsFor({ credential: relativeCredential })),
      "FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID",
      [token, credentialPath, databasePath]
    );
    expectFixedFailure(
      runCli(argumentsFor({ database: relativeDatabase })),
      "FEDERATION_BOOTSTRAP_DATABASE_INVALID",
      [token, credentialPath, databasePath]
    );
    expect(inspectServices()).toEqual([]);
  });

  it("rejects missing, symlink and non-regular databases without creating or mutating them", () => {
    const missing = join(directory, "missing.sqlite");
    const symlink = join(directory, "gateway-symlink.sqlite");
    symlinkSync(databasePath, symlink);
    const nonRegular = join(directory, "database-directory");
    mkdirSync(nonRegular);

    for (const hostile of [missing, symlink, nonRegular]) {
      const result = runCli(argumentsFor({ database: hostile }));
      expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_INVALID", [
        token,
        credentialPath,
        hostile
      ]);
    }
    expect(existsSync(missing)).toBe(false);
    expect(inspectServices()).toEqual([]);
  });

  it("rejects V13 and wrong SQLite schemas without migrating them", () => {
    const v13Path = join(directory, "gateway-v13.sqlite");
    const v13 = openGatewayDatabase(v13Path, { migrationLimit: 13 });
    v13.close();
    const wrongPath = join(directory, "wrong.sqlite");
    const wrong = new Database(wrongPath);
    wrong.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"
    );
    wrong.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(14, ?)"
    ).run("2026-08-29T00:00:00.000Z");
    wrong.close();

    for (const hostile of [v13Path, wrongPath]) {
      const result = runCli(argumentsFor({ database: hostile }));
      expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID", [
        token,
        credentialPath,
        hostile
      ]);
    }
    const verifyV13 = new Database(v13Path, { readonly: true, fileMustExist: true });
    expect(verifyV13.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 13 });
    verifyV13.close();
    expect(inspectServices()).toEqual([]);
  });

  it("rejects malformed flags, unsupported products and token arguments with fixed errors", () => {
    for (const args of [
      [],
      argumentsFor().slice(0, -2),
      argumentsFor({ product: "family" }),
      [...argumentsFor(), "--token", token],
      ["--service-ref", "bad", ...argumentsFor().slice(2)]
    ]) {
      const result = runCli(args);
      expectFixedFailure(result, "FEDERATION_BOOTSTRAP_ARGUMENTS_INVALID", [
        token,
        credentialPath,
        databasePath
      ]);
    }
    expect(inspectServices()).toEqual([]);
  });
});
