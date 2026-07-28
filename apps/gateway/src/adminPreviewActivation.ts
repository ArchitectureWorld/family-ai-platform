import {
  createHash,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  rename,
  rm
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminPreviewPersistenceInternals } from "./adminPreviewPersistence.js";
import { EntrySessionAuthenticator } from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const MAX_JSON_BYTES = 64 * 1024;
const ACTIVATION_LIFETIME_MS = 5 * 60 * 1000;
const CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/u;
const SALT = /^[A-Za-z0-9_-]{22}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const FAMILY_REF = /^family:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const PERSON_REF = /^person:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const DEVICE_REF = /^device:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const BINDING_REF =
  /^entry-binding:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const SESSION_REF =
  /^entry-session:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;

const requestSchema = z.object({
  code: z.string().regex(CODE)
}).strict();

const activationSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  expiresAt: z.string(),
  salt: z.string().regex(SALT),
  codeHash: z.string().regex(HASH)
}).strict();

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
  constructor(readonly reason: "missing" | "unsafe" | "invalid") {
    super(`PREVIEW_PROTECTED_FILE_${reason.toUpperCase()}`);
    this.name = "ProtectedFileError";
  }
}

function activationInvalid(statusCode: 400 | 401): GatewayDomainError {
  return new GatewayDomainError(
    "PREVIEW_ACTIVATION_INVALID",
    statusCode,
    statusCode === 400 ? "validation" : "permission",
    false,
    "管理员激活码无效。"
  );
}

function activationExpired(): GatewayDomainError {
  return new GatewayDomainError(
    "PREVIEW_ACTIVATION_EXPIRED",
    410,
    "permission",
    false,
    "管理员激活码已过期。"
  );
}

function activationUnavailable(): GatewayDomainError {
  return new GatewayDomainError(
    "PREVIEW_ACTIVATION_UNAVAILABLE",
    404,
    "permission",
    false,
    "当前没有可用的管理员激活码。"
  );
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
    throw new ProtectedFileError("unsafe");
  }
}

async function readProtectedBytes(path: string): Promise<Buffer> {
  exactAbsolutePath(path);
  const parentInfo = await lstat(dirname(path)).catch(() => {
    throw new ProtectedFileError("unsafe");
  });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new ProtectedFileError("unsafe");
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ProtectedFileError("missing");
    if (code === "ELOOP") throw new ProtectedFileError("unsafe");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size <= 0 ||
      info.size > MAX_JSON_BYTES
    ) {
      throw new ProtectedFileError("unsafe");
    }
    const bytes = await handle.readFile();
    if (bytes.length <= 0 || bytes.length > MAX_JSON_BYTES) {
      throw new ProtectedFileError("unsafe");
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
    throw new ProtectedFileError("invalid");
  }
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function activationDigest(salt: string, code: string): Buffer {
  return createHash("sha256")
    .update(`${salt}\0${code}`, "utf8")
    .digest();
}

async function consumeActivation(
  activationPath: string,
  originalBytes: Buffer
): Promise<void> {
  const claimPath = `${activationPath}.claim.${randomUUID()}`;
  let claimed = false;
  try {
    try {
      await rename(activationPath, claimPath);
      claimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw activationUnavailable();
      }
      throw error;
    }
    const claimedBytes = await readProtectedBytes(claimPath);
    if (!equalBytes(originalBytes, claimedBytes)) {
      try {
        await link(claimPath, activationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      throw activationUnavailable();
    }
  } finally {
    if (claimed) await rm(claimPath, { force: true });
  }
}

export function registerAdminPreviewActivation(
  app: FastifyInstance,
  input: {
    mode: "test" | "development" | "production";
    adminEntryPath?: string;
    origin?: string;
    entryAuthenticator: EntrySessionAuthenticator;
    now?: () => Date;
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
  const activationPath = join(dirname(adminEntryPath), "admin-activation.json");
  const now = input.now ?? (() => new Date());

  app.post("/api/v1/admin/preview-activation", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsedRequest = requestSchema.safeParse(request.body);
    if (!parsedRequest.success) throw activationInvalid(400);

    let activationBytes: Buffer;
    try {
      activationBytes = await readProtectedBytes(activationPath);
    } catch (error) {
      if (error instanceof ProtectedFileError) throw activationUnavailable();
      throw error;
    }
    let activationValue: unknown;
    try {
      activationValue = parseJson(activationBytes);
    } catch (error) {
      if (error instanceof ProtectedFileError) throw activationUnavailable();
      throw error;
    }
    const parsedActivation = activationSchema.safeParse(activationValue);
    if (!parsedActivation.success) throw activationUnavailable();
    const createdAt = Date.parse(parsedActivation.data.createdAt);
    const expiresAt = Date.parse(parsedActivation.data.expiresAt);
    const current = now().getTime();
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt - createdAt !== ACTIVATION_LIFETIME_MS ||
      current < createdAt
    ) {
      throw activationUnavailable();
    }
    if (current >= expiresAt) throw activationExpired();

    const submittedHash = activationDigest(
      parsedActivation.data.salt,
      parsedRequest.data.code
    );
    const expectedHash = Buffer.from(parsedActivation.data.codeHash, "hex");
    if (!equalBytes(submittedHash, expectedHash)) throw activationInvalid(401);

    let adminBytes: Buffer;
    try {
      adminBytes = await readProtectedBytes(adminEntryPath);
    } catch (error) {
      if (error instanceof ProtectedFileError) throw adminEntryInvalid();
      throw error;
    }
    let adminValue: unknown;
    try {
      adminValue = parseJson(adminBytes);
    } catch (error) {
      if (error instanceof ProtectedFileError) throw adminEntryInvalid();
      throw error;
    }
    const parsedAdmin = adminEntrySchema.safeParse(adminValue);
    if (!parsedAdmin.success || parsedAdmin.data.origin !== origin) {
      throw adminEntryInvalid();
    }
    const authentication = input.entryAuthenticator.authenticate(
      parsedAdmin.data.entrySessionRef,
      parsedAdmin.data.token
    );
    if (
      authentication.status !== "authenticated" ||
      authentication.context.audience !== "family_admin"
    ) {
      throw adminEntryInvalid();
    }

    await consumeActivation(activationPath, activationBytes);
    return {
      adminCredential: {
        kind: "entry",
        entrySessionRef: parsedAdmin.data.entrySessionRef,
        token: parsedAdmin.data.token
      }
    };
  });
}

export const adminPreviewActivationInternals = Object.freeze({
  activationDigest,
  equalBytes,
  readProtectedBytes
});
