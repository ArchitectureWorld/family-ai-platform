import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openGatewayDatabase } from "../src/database.js";
import {
  provisionFederationService,
  readProtectedFederationCredential
} from "../src/provisionFederationService.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "apps/gateway/src/provisionFederationService.ts");
const raceWorker = join(
  root,
  "apps/gateway/test/fixtures/federationProvisionRaceWorker.mjs"
);
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
  args = argumentsFor(),
  timeout?: number
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
    ...(timeout === undefined ? {} : { timeout })
  });
}

function runDevPackageCli(args = argumentsFor()): SpawnSyncReturns<string> {
  return spawnSync("npm", [
    "--silent",
    "run",
    "provision:federation-service:dev",
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

function inspectServicesAt(path = databasePath): Array<Record<string, unknown>> {
  const database = new Database(path, {
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

const inspectServices = () => inspectServicesAt(databasePath);

async function runRaceCli(
  targetStage: string,
  swap: () => void
): Promise<SpawnSyncReturns<string>> {
  const stageFile = join(directory, `race-${targetStage}.ready`);
  const continueFile = join(directory, `race-${targetStage}.continue`);
  const child = spawn(process.execPath, [raceWorker, JSON.stringify({
    argv: argumentsFor(),
    targetStage,
    stageFile,
    continueFile
  })], {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const completion = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    }
  );
  const deadline = Date.now() + 3_000;
  while (!existsSync(stageFile) && child.exitCode === null && Date.now() < deadline) {
    await delay(10);
  }
  if (!existsSync(stageFile)) {
    child.kill("SIGKILL");
    await completion;
    return { pid: child.pid ?? 0, output: [stdout, stderr], stdout, stderr, status: null,
      signal: "SIGKILL", error: new Error("RACE_CHECKPOINT_TIMEOUT") };
  }
  swap();
  writeFileSync(continueFile, "continue\n", { mode: 0o600 });
  const completed = await completion;
  return {
    pid: child.pid ?? 0,
    output: [stdout, stderr],
    stdout,
    stderr,
    status: completed.status,
    signal: completed.signal,
    error: undefined
  };
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
    const result = runDevPackageCli();

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

  it("rejects a FIFO credential without blocking the subprocess", () => {
    const fifo = join(directory, "credential.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    const result = runCli(argumentsFor({ credential: fifo }), 1_000);

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID", [
      token,
      fifo,
      databasePath
    ]);
    expect(result.error).toBeUndefined();
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

  it("rejects writable parent/database metadata and hard-linked databases", () => {
    chmodSync(directory, 0o770);
    expectFixedFailure(
      runCli(),
      "FEDERATION_BOOTSTRAP_DATABASE_INVALID",
      [token, credentialPath, databasePath]
    );
    chmodSync(directory, 0o700);

    chmodSync(databasePath, 0o660);
    expectFixedFailure(
      runCli(),
      "FEDERATION_BOOTSTRAP_DATABASE_INVALID",
      [token, credentialPath, databasePath]
    );
    chmodSync(databasePath, 0o640);

    const hardLink = join(directory, "gateway-hard-link.sqlite");
    linkSync(databasePath, hardLink);
    expectFixedFailure(
      runCli(),
      "FEDERATION_BOOTSTRAP_DATABASE_INVALID",
      [token, credentialPath, databasePath, hardLink]
    );
    unlinkSync(hardLink);
    expect(inspectServices()).toEqual([]);
  });

  it("rejects a database reached through a symlinked parent directory", () => {
    const realParent = join(directory, "real-parent");
    mkdirSync(realParent, { mode: 0o700 });
    const linkedParent = join(directory, "linked-parent");
    symlinkSync(realParent, linkedParent);
    const linkedDatabase = join(realParent, "gateway.sqlite");
    const database = openGatewayDatabase(linkedDatabase);
    database.close();

    const result = runCli(argumentsFor({
      database: join(linkedParent, "gateway.sqlite")
    }));

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_INVALID", [
      token,
      credentialPath,
      linkedDatabase,
      linkedParent
    ]);
    expect(inspectServicesAt(linkedDatabase)).toEqual([]);
  });

  it.each([
    ["parent", { expectedParentUid: process.getuid() + 1 }],
    ["database", { expectedDatabaseUid: process.getuid() + 1 }]
  ])("rejects a %s owner mismatch through the deterministic security hook", (_label, hooks) => {
    const provisionWithHooks = provisionFederationService as unknown as (
      argv: readonly string[],
      hooks: Record<string, unknown>
    ) => unknown;

    expect(() => provisionWithHooks(argumentsFor(), hooks)).toThrow(
      "FEDERATION_BOOTSTRAP_DATABASE_INVALID"
    );
    expect(inspectServices()).toEqual([]);
  });

  it.each([
    ["afterReadonlyOpen", "symlink"],
    ["afterWritableOpen", "regular"],
    ["afterProvision", "regular"]
  ])(
    "fails closed when a subprocess swaps after %s to a %s database path",
    async (targetStage, replacementKind) => {
      const originalPath = join(directory, `original-${targetStage}.sqlite`);
      const replacementPath = join(directory, `replacement-${targetStage}.sqlite`);
      const replacement = openGatewayDatabase(replacementPath);
      replacement.close();

      const result = await runRaceCli(targetStage, () => {
        renameSync(databasePath, originalPath);
        if (replacementKind === "symlink") {
          symlinkSync(replacementPath, databasePath);
        } else {
          renameSync(replacementPath, databasePath);
        }
      });

      expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_INVALID", [
        token,
        credentialPath,
        databasePath,
        originalPath,
        replacementPath
      ]);
      const wrongDatabase = replacementKind === "symlink"
        ? replacementPath
        : databasePath;
      expect(inspectServicesAt(wrongDatabase)).toEqual([]);
    }
  );

  it("fails closed while another SQLite connection holds a live read transaction", () => {
    const liveConnection = new Database(databasePath, { fileMustExist: true });
    liveConnection.exec("BEGIN");
    liveConnection.prepare("SELECT COUNT(*) AS count FROM federation_services").get();
    try {
      const result = runCli();

      expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_INVALID", [
        token,
        credentialPath,
        databasePath
      ]);
    } finally {
      liveConnection.exec("ROLLBACK");
      liveConnection.close();
    }
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

  it("rejects a weak V14 lookalike with identical federation service columns", () => {
    const weak = new Database(databasePath, { fileMustExist: true });
    weak.pragma("foreign_keys = OFF");
    weak.exec(`DROP TABLE federation_services;
    CREATE TABLE federation_services (
      service_ref TEXT PRIMARY KEY,
      product TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );`);
    weak.close();

    const result = runCli();

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID", [
      token,
      credentialPath,
      databasePath
    ]);
    expect(inspectServices()).toEqual([]);
  });

  it("rejects V14 when the required invocation scope index is absent", () => {
    const weak = new Database(databasePath, { fileMustExist: true });
    weak.exec("DROP INDEX agent_invocation_audit_scope_idx");
    weak.close();

    const result = runCli();

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID", [
      token,
      credentialPath,
      databasePath
    ]);
    expect(inspectServices()).toEqual([]);
  });

  it("rejects a binding lookalike that omits the required Family foreign keys", () => {
    const weak = new Database(databasePath, { fileMustExist: true });
    weak.pragma("foreign_keys = OFF");
    weak.exec(`DROP TABLE federation_session_bindings;
      CREATE TABLE federation_session_bindings (
        product TEXT NOT NULL CHECK(product IN ('canvas', 'me')),
        family_ref TEXT NOT NULL,
        person_ref TEXT NOT NULL,
        agent_ref TEXT NOT NULL,
        local_session_ref TEXT NOT NULL,
        external_session_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(product, family_ref, person_ref, agent_ref, local_session_ref)
      );`);
    weak.close();

    const result = runCli();

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID", [
      token,
      credentialPath,
      databasePath
    ]);
    expect(inspectServices()).toEqual([]);
  });

  it("rejects a federation service lookalike with weakened nullability", () => {
    const weak = new Database(databasePath, { fileMustExist: true });
    weak.pragma("foreign_keys = OFF");
    weak.exec(`DROP TABLE federation_services;
      CREATE TABLE federation_services (
        service_ref TEXT PRIMARY KEY,
        product TEXT CHECK(product IN ('canvas', 'me')),
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );`);
    weak.close();

    const result = runCli();

    expectFixedFailure(result, "FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID", [
      token,
      credentialPath,
      databasePath
    ]);
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
