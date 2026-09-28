import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  clearWebSessionCookieHeaders,
  parseCookieHeader,
  setWebEntrySessionCookieHeaders,
  WEB_COOKIE_NAMES,
  webAuthenticationSource
} from "./webEntryCookies.js";
import { EntrySessionAuthenticator, requireEntryRequestWithSession } from "./entrySessionAuth.js";
import { FamilyDomainRepository } from "./familyDomain.js";
import { GatewayDomainError } from "./service.js";

const MAX_FILE_BYTES = 64 * 1024;
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_PATTERN = /^entry-session:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const FAMILY_PATTERN = /^family:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const PERSON_PATTERN = /^person:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const DEVICE_PATTERN = /^device:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const BINDING_PATTERN = /^entry-binding:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ACTIVATION_TTL_MS = 5 * 60 * 1000;

export interface ProductionAdminEntry {
  readonly version: 1;
  readonly origin: string;
  readonly familyRef: string;
  readonly personRef: string;
  readonly deviceRef: string;
  readonly entryBindingRef: string;
  readonly entrySessionRef: string;
  readonly token: string;
}

interface LegacyProductionActivationRecord {
  readonly version: 1;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly salt: string;
  readonly codeHash: string;
}

interface ProductionActivationRecordV2 {
  readonly version: 2;
  readonly createdAt: string;
  readonly salt: string;
  readonly codeHash: string;
  readonly failedAttempts: number;
}

type ProductionActivationRecord = LegacyProductionActivationRecord | ProductionActivationRecordV2;

export interface ProductionAdminActivation {
  readonly code: string;
  readonly outputPath: string;
}

function protectedError(): Error {
  return new Error("PROTECTED_ADMIN_FILE_INVALID");
}

function invalidActivation(): GatewayDomainError {
  return new GatewayDomainError(
    "ADMIN_ACTIVATION_INVALID",
    401,
    "permission",
    false,
    "管理员激活码无效、已使用或已锁定。"
  );
}

function exactPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") {
    throw protectedError();
  }
}

async function readProtectedBytes(path: string): Promise<Buffer> {
  exactPath(path);
  let parent;
  try {
    parent = await lstat(dirname(path));
  } catch {
    throw protectedError();
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) > 0o700) {
    throw protectedError();
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw protectedError();
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size <= 0 ||
      info.size > MAX_FILE_BYTES
    ) {
      throw protectedError();
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw protectedError();
  }
}

function parseAdminEntry(value: unknown): ProductionAdminEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protectedError();
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join("\0");
  if (
    keys !==
      "deviceRef\0entryBindingRef\0entrySessionRef\0familyRef\0origin\0personRef\0token\0version" ||
    candidate.version !== 1 ||
    typeof candidate.origin !== "string" ||
    !/^https:\/\/[^/]+(?::\d+)?$/u.test(candidate.origin) ||
    !FAMILY_PATTERN.test(String(candidate.familyRef)) ||
    !PERSON_PATTERN.test(String(candidate.personRef)) ||
    !DEVICE_PATTERN.test(String(candidate.deviceRef)) ||
    !BINDING_PATTERN.test(String(candidate.entryBindingRef)) ||
    !SESSION_PATTERN.test(String(candidate.entrySessionRef)) ||
    !TOKEN_PATTERN.test(String(candidate.token))
  ) {
    throw protectedError();
  }
  return candidate as unknown as ProductionAdminEntry;
}

function parseActivation(value: unknown): ProductionActivationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protectedError();
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join("\0");
  const legacy = candidate.version === 1 &&
    keys === "codeHash\0createdAt\0expiresAt\0salt\0version" &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt));
  const current = candidate.version === 2 &&
    keys === "codeHash\0createdAt\0failedAttempts\0salt\0version" &&
    Number.isInteger(candidate.failedAttempts) &&
    Number(candidate.failedAttempts) >= 0 &&
    Number(candidate.failedAttempts) <= 10;
  if (
    (!legacy && !current) ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    typeof candidate.salt !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(candidate.salt) ||
    typeof candidate.codeHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.codeHash)
  ) {
    throw protectedError();
  }
  return candidate as unknown as ProductionActivationRecord;
}

function hashCode(salt: Buffer, code: string): Buffer {
  return createHash("sha256")
    .update(salt)
    .update(code, "utf8")
    .digest();
}

function constantTimeHashEqual(leftHex: string, right: Buffer): boolean {
  const left = Buffer.from(leftHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomCode(randomBytesImpl: (size: number) => Buffer): string {
  const values = randomBytesImpl(10);
  let result = "";
  for (const value of values.subarray(0, 10)) {
    result += CODE_ALPHABET[value % CODE_ALPHABET.length];
  }
  return `${result.slice(0, 5)}-${result.slice(5)}`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  exactPath(path);
  const temporary = `${path}.tmp.${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    const handle = await open(temporary, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function acquireActivationLock(path: string): Promise<string> {
  exactPath(path);
  const lockPath = `${path}.lock`;
  const handle = await open(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  await handle.close();
  return lockPath;
}

export async function createProductionAdminActivation(input: {
  adminEntryPath: string;
  activationPath: string;
  now?: () => Date;
  randomBytesImpl?: (size: number) => Buffer;
}): Promise<ProductionAdminActivation> {
  parseAdminEntry(parseJson(await readProtectedBytes(input.adminEntryPath)));
  const now = input.now ?? (() => new Date());
  const createdAt = now();
  const random = input.randomBytesImpl ?? randomBytes;
  const salt = random(16);
  if (!Buffer.isBuffer(salt) || salt.length !== 16) throw protectedError();
  const code = randomCode(random);
  const lockPath = await acquireActivationLock(input.activationPath);
  let written = false;
  try {
    await atomicWrite(
      input.activationPath,
      `${JSON.stringify({
        version: 2,
        createdAt: createdAt.toISOString(),
        salt: salt.toString("base64url"),
        codeHash: hashCode(salt, code).toString("hex"),
        failedAttempts: 0
      })}\n`
    );
    written = true;
    return { code, outputPath: input.activationPath };
  } finally {
    if (written) await rm(lockPath);
  }
}

function sameOrigin(request: FastifyRequest, origin: string): boolean {
  return request.headers.origin === origin && request.headers["sec-fetch-site"] === "same-origin";
}

async function consumeActivation(path: string): Promise<void> {
  const consumed = `${path}.consumed.${randomUUID()}`;
  try {
    await rename(path, consumed);
    await rm(consumed, { force: true });
  } catch {
    await rm(consumed, { force: true });
    throw invalidActivation();
  }
}

function sendActivationCookies(reply: FastifyReply, entry: { entrySessionRef: string; token: string }): void {
  reply.header(
    "Set-Cookie",
    setWebEntrySessionCookieHeaders(
      { entrySessionRef: entry.entrySessionRef, entryToken: entry.token },
      "production",
      { persistent: true }
    )
  );
}

export function registerAdminProductionActivation(
  app: FastifyInstance,
  input: {
    mode: "test" | "development" | "production";
    enabled: boolean;
    adminEntryPath?: string;
    activationPath?: string;
    adminWebOrigin?: string;
    entryAuthenticator: EntrySessionAuthenticator;
    familyRepository: FamilyDomainRepository;
    now?: () => Date;
  }
): void {
  if (
    !input.enabled ||
    (input.mode !== "production" && input.mode !== "development") ||
    input.adminEntryPath === undefined ||
    input.activationPath === undefined ||
    input.adminWebOrigin === undefined
  ) {
    return;
  }
  const now = input.now ?? (() => new Date());
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      request.method !== "GET" ||
      reply.statusCode >= 400 ||
      !(request.url === "/api/v1/portal/context" || request.url.startsWith("/api/v1/admin/")) ||
      webAuthenticationSource(request) !== "entry_cookie"
    ) return payload;
    const cookies = parseCookieHeader(request.headers.cookie);
    const entrySessionRef = cookies[WEB_COOKIE_NAMES.entrySessionRef];
    const entryToken = cookies[WEB_COOKIE_NAMES.entryToken];
    if (!entrySessionRef || !entryToken) return payload;
    const authentication = input.entryAuthenticator.authenticate(entrySessionRef, entryToken);
    if (authentication.status === "authenticated" && authentication.context.audience === "family_admin") {
      reply.header("Set-Cookie", setWebEntrySessionCookieHeaders(
        { entrySessionRef, entryToken }, "production", { persistent: true }
      ));
    }
    return payload;
  });
  app.post("/api/v1/admin/activate", async (request, reply) => {
    if (!sameOrigin(request, input.adminWebOrigin!)) throw invalidActivation();
    const body = request.body;
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body as object).length !== 1 ||
      typeof (body as { code?: unknown }).code !== "string" ||
      !CODE_PATTERN.test((body as { code: string }).code)
    ) {
      throw invalidActivation();
    }
    let lockPath: string | null = null;
    let releaseLock = false;
    try {
      lockPath = await acquireActivationLock(input.activationPath!);
      const activation = parseActivation(
        parseJson(await readProtectedBytes(input.activationPath!))
      );
      const entry = parseAdminEntry(parseJson(await readProtectedBytes(input.adminEntryPath!)));
      const current = now().getTime();
      const isBeforeCreation = current < Date.parse(activation.createdAt);
      const isExpiredLegacy = activation.version === 1 &&
        current >= Date.parse(activation.expiresAt);
      const isLocked = activation.version === 2 && activation.failedAttempts >= 10;
      const matches = constantTimeHashEqual(
        activation.codeHash,
        hashCode(Buffer.from(activation.salt, "base64url"), (body as { code: string }).code)
      );
      if (isBeforeCreation || isExpiredLegacy || isLocked || !matches) {
        if (
          activation.version === 2 &&
          !isBeforeCreation && !isLocked && !matches
        ) {
          await atomicWrite(input.activationPath!, `${JSON.stringify({
            ...activation,
            failedAttempts: activation.failedAttempts + 1
          })}\n`);
        }
        releaseLock = true;
        throw invalidActivation();
      }
      const authentication = input.entryAuthenticator.authenticate(
        entry.entrySessionRef,
        entry.token
      );
      if (
        authentication.status !== "authenticated" ||
        entry.origin !== input.adminWebOrigin ||
        authentication.context.audience !== "family_admin" ||
        authentication.context.family.familyRef !== entry.familyRef ||
        authentication.context.person.personRef !== entry.personRef ||
        authentication.context.device.deviceRef !== entry.deviceRef ||
        authentication.context.entryBindingRef !== entry.entryBindingRef
      ) {
        releaseLock = true;
        throw invalidActivation();
      }
      await consumeActivation(input.activationPath!);
      releaseLock = true;
      const browserSession = input.familyRepository.issueAdminBrowserSession(
        entry.entrySessionRef, now()
      );
      reply
        .header("Cache-Control", "no-store")
        .header("Pragma", "no-cache");
      sendActivationCookies(reply, browserSession);
      return reply.send({ activated: true });
    } catch (error) {
      if (error instanceof GatewayDomainError) throw error;
      throw invalidActivation();
    } finally {
      if (lockPath !== null && releaseLock) await rm(lockPath, { force: true });
    }
  });
  app.post("/api/v1/admin/logout", async (request, reply) => {
    if (!sameOrigin(request, input.adminWebOrigin!)) throw invalidActivation();
    if (webAuthenticationSource(request) !== "entry_cookie") throw invalidActivation();
    const authenticated = requireEntryRequestWithSession(
      request, input.entryAuthenticator, "family_admin"
    );
    const operatorEntry = parseAdminEntry(
      parseJson(await readProtectedBytes(input.adminEntryPath!))
    );
    if (authenticated.entrySessionRef !== operatorEntry.entrySessionRef) {
      input.familyRepository.revokeAdminBrowserSession(
        authenticated.entrySessionRef, authenticated.context.entryBindingRef, now()
      );
    }
    reply.header("Set-Cookie", clearWebSessionCookieHeaders("production"));
    return reply.send({ loggedOut: true });
  });
}

export const productionAdminActivationInternals = Object.freeze({
  CODE_PATTERN,
  ACTIVATION_TTL_MS,
  parseAdminEntry,
  parseActivation,
  hashCode,
  readProtectedBytes
});
