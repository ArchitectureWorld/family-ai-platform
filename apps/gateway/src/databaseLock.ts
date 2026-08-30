import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GatewayDatabaseLockRole = "gateway" | "migrate" | "provision";

export interface GatewayDatabaseLockLease {
  lockDev: bigint;
  lockIno: bigint;
  close: () => void;
}

const LOCK_DESCRIPTOR = 3;
const LOCK_NAME = ".family-ai-gateway.lock";
const APP_UID = 1000;
const APP_GID = 1000;
const launcher = fileURLToPath(
  new URL("../runtime/gateway_lock_exec.py", import.meta.url)
);

function fail(): never {
  throw new Error("GATEWAY_DATABASE_LOCK_INVALID");
}

function exactDatabasePath(path: string): string {
  if (!isAbsolute(path) || path === "/" || resolve(path) !== path) fail();
  return path;
}

interface GatewayDatabaseLockIdentity {
  uid: number;
  gid: number;
}

function protectedDirectory(
  state: BigIntStats,
  identity: GatewayDatabaseLockIdentity
): boolean {
  return state.isDirectory()
    && state.uid === BigInt(identity.uid)
    && state.gid === BigInt(identity.gid)
    && (state.mode & 0o777n) === 0o700n;
}

function protectedLock(
  state: BigIntStats,
  identity: GatewayDatabaseLockIdentity
): boolean {
  return state.isFile()
    && state.uid === BigInt(identity.uid)
    && state.gid === BigInt(identity.gid)
    && state.nlink === 1n
    && (state.mode & 0o777n) === 0o600n;
}

function requireInheritedGatewayDatabaseLockWithIdentity(input: {
  role: GatewayDatabaseLockRole;
  databasePath: string;
}, identity: GatewayDatabaseLockIdentity): GatewayDatabaseLockLease {
  if (
    !Number.isSafeInteger(identity.uid)
    || identity.uid < 0
    || !Number.isSafeInteger(identity.gid)
    || identity.gid < 0
  ) fail();
  const databasePath = exactDatabasePath(input.databasePath);
  if (
    process.env.FAMILY_AI_GATEWAY_LOCK_ROLE !== input.role
    || process.env.FAMILY_AI_GATEWAY_LOCK_DATABASE !== databasePath
  ) {
    fail();
  }
  const parent = dirname(databasePath);
  const lockPath = join(parent, LOCK_NAME);
  let parentDescriptor: number | undefined;
  try {
    parentDescriptor = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const parentFd = fstatSync(parentDescriptor, { bigint: true });
    const parentPath = lstatSync(parent, { bigint: true });
    const inherited = fstatSync(LOCK_DESCRIPTOR, { bigint: true });
    const pathState = lstatSync(lockPath, { bigint: true });
    if (
      !protectedDirectory(parentFd, identity)
      || !protectedDirectory(parentPath, identity)
      || parentFd.dev !== parentPath.dev
      || parentFd.ino !== parentPath.ino
      || !protectedLock(inherited, identity)
      || !protectedLock(pathState, identity)
      || inherited.dev !== pathState.dev
      || inherited.ino !== pathState.ino
    ) {
      fail();
    }
    const asserted = spawnSync("python3", [
      launcher,
      "--assert-inherited-fd", "3",
      "--database", databasePath
    ], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", LOCK_DESCRIPTOR]
    });
    if (
      asserted.status !== 0
      || asserted.stdout !== "GATEWAY_DATABASE_LOCK_OK\n"
      || asserted.stderr !== ""
    ) {
      fail();
    }
    let closed = false;
    return {
      lockDev: inherited.dev,
      lockIno: inherited.ino,
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(LOCK_DESCRIPTOR);
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_LOCK_INVALID") throw error;
    return fail();
  } finally {
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
}

export function requireInheritedGatewayDatabaseLock(input: {
  role: GatewayDatabaseLockRole;
  databasePath: string;
}): GatewayDatabaseLockLease {
  return requireInheritedGatewayDatabaseLockWithIdentity(input, {
    uid: APP_UID,
    gid: APP_GID
  });
}

export function requireInheritedGatewayDatabaseLockForTest(input: {
  role: GatewayDatabaseLockRole;
  databasePath: string;
}, identity: GatewayDatabaseLockIdentity): GatewayDatabaseLockLease {
  if (process.env.NODE_ENV !== "test") fail();
  return requireInheritedGatewayDatabaseLockWithIdentity(input, identity);
}
