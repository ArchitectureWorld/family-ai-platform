import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  EntrySessionAuthenticator,
  requireEntryRequestWithSession
} from "./entrySessionAuth.js";

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!TOKEN.test(token)) throw new Error("PREVIEW_ADMIN_ENTRY_INVALID");
  return token;
}

function loopbackOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("PREVIEW_ADMIN_ORIGIN_INVALID");
  }
  return parsed.origin;
}

async function atomicProtectedJson(path: string, value: unknown): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("PREVIEW_ADMIN_ENTRY_PATH_INVALID");
  }
  const parent = dirname(path);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("PREVIEW_ADMIN_ENTRY_PATH_INVALID");
  }
  try {
    const targetInfo = await lstat(path);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new Error("PREVIEW_ADMIN_ENTRY_PATH_INVALID");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${path}.tmp.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await chmod(temporary, 0o600);
    const temporaryHandle = await open(temporary, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    const parentHandle = await open(parent, "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function registerAdminPreviewPersistence(
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
  const origin = loopbackOrigin(input.origin);
  const adminEntryPath = input.adminEntryPath;

  app.post("/api/v1/admin/preview-entry", async request => {
    const { context, entrySessionRef } = requireEntryRequestWithSession(
      request,
      input.entryAuthenticator,
      "family_admin"
    );
    await atomicProtectedJson(adminEntryPath, {
      version: 1,
      origin,
      familyRef: context.family.familyRef,
      personRef: context.person.personRef,
      deviceRef: context.device.deviceRef,
      entryBindingRef: context.entryBindingRef,
      entrySessionRef,
      token: bearerToken(request)
    });
    return { persisted: true };
  });
}

export const adminPreviewPersistenceInternals = Object.freeze({
  atomicProtectedJson,
  loopbackOrigin
});
