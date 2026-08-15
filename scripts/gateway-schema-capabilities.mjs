#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const fail = message => {
  process.stderr.write(`CAPABILITY_VALIDATION_FAILED:${message}\n`);
  process.exit(1);
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const readBytes = path => readFileSync(path);
const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`INVALID_JSON:${path.split("/").at(-1)}`);
  }
};
const requireAbsoluteFile = (value, name) => {
  if (!isAbsolute(value ?? "") || !existsSync(value)) fail(`INVALID_${name}`);
  const actual = realpathSync(value);
  if (actual !== resolve(value)) fail(`SYMLINK_${name}`);
  return actual;
};
const parseArgs = values => {
  if (values[0] !== "validate") fail("EXPECTED_VALIDATE_COMMAND");
  const allowed = new Set([
    "--schema-registry",
    "--release-capabilities",
    "--database-source",
    "--client-cache-source",
    "--output"
  ]);
  const result = {};
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!allowed.has(key) || value === undefined || result[key]) fail("INVALID_ARGUMENTS");
    result[key] = value;
  }
  for (const key of allowed) if (!result[key]) fail(`MISSING_${key.slice(2).toUpperCase()}`);
  return result;
};

const args = parseArgs(process.argv.slice(2));
const schemaPath = requireAbsoluteFile(args["--schema-registry"], "SCHEMA_REGISTRY");
const releasePath = requireAbsoluteFile(args["--release-capabilities"], "RELEASE_CAPABILITIES");
const databasePath = requireAbsoluteFile(args["--database-source"], "DATABASE_SOURCE");
const cachePath = requireAbsoluteFile(args["--client-cache-source"], "CLIENT_CACHE_SOURCE");
const outputPath = args["--output"];
if (!isAbsolute(outputPath ?? "") || existsSync(outputPath) || existsSync(`${outputPath}.sha256`)) {
  fail("OUTPUT_MUST_BE_ABSOLUTE_AND_NEW");
}
if (!existsSync(dirname(outputPath))) fail("OUTPUT_PARENT_MISSING");

const registry = readJson(schemaPath);
const release = readJson(releasePath);
const enums = {
  attachments: new Set(["absent-legacy", "present"]),
  attachmentJournal: new Set(["none", "journal-v1"]),
  mobileClaimReplay: new Set(["legacy", "bounded-replay-v1"]),
  providerOperations: new Set(["legacy", "durable-v1"])
};

if (registry.formatVersion !== 1 || registry.snapshotFormat?.write !== 1) {
  fail("UNSUPPORTED_SCHEMA_REGISTRY_FORMAT");
}
if (!Array.isArray(registry.snapshotFormat.read) || !registry.snapshotFormat.read.includes(1)) {
  fail("SNAPSHOT_READ_ALLOWLIST_INVALID");
}
if (!Array.isArray(registry.schemas) || registry.schemas.length === 0) fail("SCHEMAS_MISSING");
for (let index = 0; index < registry.schemas.length; index += 1) {
  const entry = registry.schemas[index];
  const expected = 3 + index;
  if (entry.schemaVersion !== expected || entry.migrationHead !== expected) {
    fail(`SCHEMA_SEQUENCE_INVALID:${expected}`);
  }
  for (const [field, values] of Object.entries(enums)) {
    if (!values.has(entry[field])) fail(`SCHEMA_ENUM_INVALID:${field}:${expected}`);
  }
}
const currentSchema = registry.schemas.at(-1).schemaVersion;
if (
  release.formatVersion !== 1 ||
  typeof release.capabilitySetId !== "string" ||
  !/^[a-z0-9][a-z0-9-]*$/.test(release.capabilitySetId) ||
  release.schemaHead !== currentSchema ||
  !Number.isInteger(release.clientDatabaseVersion) ||
  release.clientDatabaseVersion <= 0 ||
  typeof release.databaseNameScheme !== "string" ||
  typeof release.rollbackClientRequired !== "boolean"
) {
  fail("RELEASE_CAPABILITIES_INVALID");
}
if (release.rollbackClientRequired === false) {
  if (release.rollbackClientBundleFormat !== "none" || release.rollbackGuardFormat !== "none") {
    fail("ROLLBACK_FORMATS_MUST_BE_NONE");
  }
} else if (
  release.rollbackClientBundleFormat !== "sealed-static-v1" ||
  release.rollbackGuardFormat !== "static-guard-v1"
) {
  fail("ROLLBACK_FORMATS_REQUIRED");
}

const databaseSource = readFileSync(databasePath, "utf8");
const cacheSource = readFileSync(cachePath, "utf8");
if (!new RegExp(`\\bMIGRATION_V${currentSchema}\\b`).test(databaseSource)) {
  fail("DATABASE_SCHEMA_HEAD_MISMATCH");
}
const exportedVersion = cacheSource.match(
  /export\s+const\s+MEMBER_CACHE_DATABASE_VERSION\s*=\s*([1-9][0-9]*)\s*;/
);
if (!exportedVersion || Number(exportedVersion[1]) !== release.clientDatabaseVersion) {
  fail("CLIENT_DATABASE_VERSION_MISMATCH");
}
if (!/indexedDBImpl\.open\(databaseName,\s*MEMBER_CACHE_DATABASE_VERSION\)/.test(cacheSource)) {
  fail("CLIENT_DATABASE_OPEN_NOT_BOUND_TO_EXPORT");
}

const receipt = {
  manifestKind: "gateway-capability-receipt-v1",
  formatVersion: 1,
  snapshotFormat: registry.snapshotFormat,
  schemas: registry.schemas,
  release,
  evidence: {
    schemaRegistrySha256: sha256(readBytes(schemaPath)),
    releaseCapabilitiesSha256: sha256(readBytes(releasePath)),
    databaseSourceSha256: sha256(readBytes(databasePath)),
    clientCacheSourceSha256: sha256(readBytes(cachePath))
  }
};
const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
const receiptHash = sha256(receiptBytes);
process.umask(0o077);
const outputFd = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
writeFileSync(outputFd, receiptBytes);
const hashFd = openSync(`${outputPath}.sha256`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
writeFileSync(hashFd, `${receiptHash}  ${outputPath.split("/").at(-1)}\n`);
chmodSync(outputPath, 0o600);
chmodSync(`${outputPath}.sha256`, 0o600);
process.stdout.write(`${receiptHash}\n`);
