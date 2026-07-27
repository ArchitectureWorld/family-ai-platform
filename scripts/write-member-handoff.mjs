import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

class MemberHandoffInputError extends Error {
  constructor() {
    super("MEMBER_HANDOFF_INPUT_INVALID");
    this.name = "MemberHandoffInputError";
  }
}

function invalidInput() {
  throw new MemberHandoffInputError();
}

function requireNonEmptyString(value) {
  if (typeof value !== "string" || value.length === 0) invalidInput();
  return value;
}

function buildMemberHandoffUrl({ baseUrl, pairingRef, code }) {
  requireNonEmptyString(baseUrl);
  requireNonEmptyString(pairingRef);
  requireNonEmptyString(code);

  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    invalidInput();
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username !== "" ||
    base.password !== ""
  ) {
    invalidInput();
  }

  const handoff = new URL("/member/", base);
  handoff.search = "";
  handoff.hash = new URLSearchParams({ pairingRef, code }).toString();
  return handoff.toString();
}

async function removeTemporaryFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function writeMemberHandoff({ outputPath, baseUrl, pairingRef, code }) {
  requireNonEmptyString(outputPath);
  const handoffUrl = buildMemberHandoffUrl({ baseUrl, pairingRef, code });
  const directory = dirname(outputPath);
  const outputName = basename(outputPath);
  const temporaryPath = join(
    directory,
    `.${outputName}.${process.pid}.${randomUUID()}.tmp`
  );
  let file;

  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${handoffUrl}\n`, "utf8");
    await file.chmod(0o600);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, outputPath);
  } finally {
    try {
      if (file) await file.close();
    } finally {
      await removeTemporaryFile(temporaryPath);
    }
  }
}

function parseCliInput(buffer) {
  let input;
  try {
    input = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    invalidInput();
  }
  const fields = input.split("\u0000");
  if (
    fields.length !== 4 ||
    fields[3] !== "" ||
    fields.slice(0, 3).some(field => field.length === 0)
  ) {
    invalidInput();
  }
  return {
    baseUrl: fields[0],
    pairingRef: fields[1],
    code: fields[2]
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main() {
  if (process.argv.length !== 3) invalidInput();
  const outputPath = process.argv[2];
  const input = parseCliInput(await readStdin());
  await writeMemberHandoff({ outputPath, ...input });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";

if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof MemberHandoffInputError
        ? "MEMBER_HANDOFF_INPUT_INVALID\n"
        : "MEMBER_HANDOFF_WRITE_FAILED\n";
    process.stderr.write(message);
    process.exitCode = 1;
  }
}
