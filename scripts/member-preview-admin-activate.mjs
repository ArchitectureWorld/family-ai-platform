import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { previewInternals } from "./member-preview-pair.mjs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIFETIME_MS = 5 * 60 * 1000;

function fail(code) {
  throw new previewInternals.PreviewError(code);
}

function symbols(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 10) {
    fail("PREVIEW_ACTIVATION_RANDOM_INVALID");
  }
  return [...bytes.subarray(0, 10)]
    .map(value => ALPHABET[value & 31])
    .join("");
}

function hashCode(salt, code) {
  return createHash("sha256")
    .update(`${salt}\0${code}`, "utf8")
    .digest("hex");
}

export async function createAdminPreviewActivation(options = {}) {
  const paths = await previewInternals.prepareRuntime(options.runtimeDir);
  await previewInternals.protectedFile(
    join(paths.configDir, "admin-entry.json")
  );
  const now = (options.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("PREVIEW_ACTIVATION_TIME_INVALID");
  }
  const random = options.randomBytesImpl ?? randomBytes;
  const raw = symbols(random(10));
  const saltBytes = random(16);
  if (!Buffer.isBuffer(saltBytes) || saltBytes.length !== 16) {
    fail("PREVIEW_ACTIVATION_RANDOM_INVALID");
  }
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  const salt = saltBytes.toString("base64url");
  const outputPath = join(paths.configDir, "admin-activation.json");
  const expiresAt = new Date(now.getTime() + LIFETIME_MS).toISOString();
  await previewInternals.atomicProtectedJson(outputPath, {
    version: 1,
    createdAt: now.toISOString(),
    expiresAt,
    salt,
    codeHash: hashCode(salt, code)
  });
  return { code, expiresAt, outputPath };
}

function parseCli(argv) {
  if (argv.length !== 0) fail("PREVIEW_ACTIVATION_ARGUMENTS_INVALID");
}

async function main() {
  parseCli(process.argv.slice(2));
  const result = await createAdminPreviewActivation();
  process.stdout.write(`${result.code} expiresAt=${result.expiresAt}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch {
    process.stderr.write("PREVIEW_ADMIN_ACTIVATION_FAILED\n");
    process.exitCode = 1;
  }
}

export const adminActivationInternals = Object.freeze({
  hashCode,
  parseCli,
  symbols
});
