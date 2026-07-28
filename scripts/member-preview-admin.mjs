import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadPreviewAdminHandoff,
  previewInternals
} from "./member-preview-pair.mjs";

function fail(code) {
  throw new previewInternals.PreviewError(code);
}

function privateIpv4(value) {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part))
  ) {
    return false;
  }
  const numbers = parts.map(Number);
  if (numbers.some(number => number < 0 || number > 255)) return false;
  return numbers[0] === 10 ||
    (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) ||
    (numbers[0] === 192 && numbers[1] === 168);
}

export function normalizeAdminLanOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("PREVIEW_ADMIN_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "9443" ||
    !privateIpv4(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail("PREVIEW_ADMIN_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function handoffFragment(credential) {
  if (credential.kind === "entry") {
    return new URLSearchParams({
      entrySessionRef: credential.entrySessionRef,
      token: credential.token
    });
  }
  if (credential.kind === "bootstrap") {
    return new URLSearchParams({
      deviceRef: credential.deviceRef,
      bootstrapToken: credential.token
    });
  }
  fail("PREVIEW_ADMIN_HANDOFF_INVALID");
}

export async function createAdminPreviewHandoff(options = {}) {
  const origin = normalizeAdminLanOrigin(options.origin);
  const credential = await loadPreviewAdminHandoff({
    origin: options.gatewayOrigin ?? "http://127.0.0.1:8791",
    runtimeDir: options.runtimeDir,
    fetchImpl: options.fetchImpl
  });
  const paths = await previewInternals.prepareRuntime(credential.runtimeDir);
  const outputPath = join(paths.configDir, "admin-web-url-9443");
  const fragment = handoffFragment(credential);
  await previewInternals.atomicProtectedText(
    outputPath,
    `${origin}/admin/#${fragment.toString()}\n`
  );
  const info = await lstat(outputPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o600
  ) {
    fail("PREVIEW_ADMIN_HANDOFF_INVALID");
  }
  return outputPath;
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--origin") {
    fail("PREVIEW_ADMIN_ARGUMENTS_INVALID");
  }
  return argv[1];
}

async function main() {
  const origin = parseCli(process.argv.slice(2));
  const outputPath = await createAdminPreviewHandoff({ origin });
  process.stdout.write(`${outputPath}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch {
    process.stderr.write("PREVIEW_ADMIN_FAILED\n");
    process.exitCode = 1;
  }
}

export const adminPreviewInternals = Object.freeze({
  handoffFragment,
  parseCli,
  privateIpv4
});
