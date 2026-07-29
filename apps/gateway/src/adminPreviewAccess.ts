import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminPreviewPersistenceInternals } from "./adminPreviewPersistence.js";
import { EntrySessionAuthenticator } from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const MAX_JSON_BYTES = 64 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const FAMILY_REF = /^family:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const PERSON_REF = /^person:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const DEVICE_REF = /^device:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const BINDING_REF =
  /^entry-binding:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const SESSION_REF =
  /^entry-session:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;

const adminEntrySchema = z.object({
  version: z.literal(1),
  origin: z.string(),
  familyRef: z.string().regex(FAMILY_REF),
  personRef: z.string().regex(PERSON_REF),
  deviceRef: z.string().regex(DEVICE_REF),
  entryBindingRef: z.string().regex(BINDING_REF),
  entrySessionRef: z.string().regex(SESSION_REF),
  token: z.string().regex(TOKEN)
}).strict();

class ProtectedFileError extends Error {
  constructor() {
    super("PREVIEW_PROTECTED_FILE_INVALID");
    this.name = "ProtectedFileError";
  }
}

function adminEntryInvalid(): GatewayDomainError {
  return new GatewayDomainError(
    "PREVIEW_ADMIN_ENTRY_INVALID",
    401,
    "permission",
    false,
    "管理员入口无效。"
  );
}

function exactAbsolutePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new ProtectedFileError();
  }
}

async function readProtectedBytes(path: string): Promise<Buffer> {
  exactAbsolutePath(path);
  const parentInfo = await lstat(dirname(path)).catch(() => {
    throw new ProtectedFileError();
  });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new ProtectedFileError();
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ProtectedFileError();
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size <= 0 ||
      info.size > MAX_JSON_BYTES
    ) {
      throw new ProtectedFileError();
    }
    const bytes = await handle.readFile();
    if (bytes.length <= 0 || bytes.length > MAX_JSON_BYTES) {
      throw new ProtectedFileError();
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new ProtectedFileError();
  }
}

export function registerAdminPreviewAccess(
  app: FastifyInstance,
  input: {
    mode: "test" | "development" | "production";
    adminEntryPath?: string;
    origin?: string;
    entryAuthenticator: EntrySessionAuthenticator;
  }
): void {
  if (
    input.mode !== "development" ||
    input.adminEntryPath === undefined ||
    input.origin === undefined
  ) {
    return;
  }
  const origin = adminPreviewPersistenceInternals.loopbackOrigin(input.origin);
  const adminEntryPath = input.adminEntryPath;
  exactAbsolutePath(adminEntryPath);

  app.get("/api/v1/admin/access-mode", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { mode: "preview-auto" };
  });

  app.post("/api/v1/admin/preview-access", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    let value: unknown;
    try {
      value = parseJson(await readProtectedBytes(adminEntryPath));
    } catch (error) {
      if (error instanceof ProtectedFileError) throw adminEntryInvalid();
      throw error;
    }
    const parsed = adminEntrySchema.safeParse(value);
    if (!parsed.success || parsed.data.origin !== origin) {
      throw adminEntryInvalid();
    }
    const authentication = input.entryAuthenticator.authenticate(
      parsed.data.entrySessionRef,
      parsed.data.token
    );
    if (
      authentication.status !== "authenticated" ||
      authentication.context.audience !== "family_admin" ||
      authentication.context.family.familyRef !== parsed.data.familyRef ||
      authentication.context.person.personRef !== parsed.data.personRef ||
      authentication.context.device.deviceRef !== parsed.data.deviceRef ||
      authentication.context.entryBindingRef !== parsed.data.entryBindingRef
    ) {
      throw adminEntryInvalid();
    }
    return {
      adminCredential: {
        kind: "entry",
        entrySessionRef: parsed.data.entrySessionRef,
        token: parsed.data.token
      }
    };
  });
}

export const adminPreviewAccessInternals = Object.freeze({
  readProtectedBytes
});
