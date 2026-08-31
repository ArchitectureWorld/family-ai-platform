import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { GatewayDatabaseLockLease } from "./databaseLock.js";
import type { validateImmutableGatewayV15Database } from "./databaseSecurity.js";

const claimedRecoveryLockBrand: unique symbol = Symbol("claimedRecoveryLock");
const claimedRecoveryLeases = new WeakSet<object>();
const APP_UID = 1000;
const APP_GID = 1000;

export type RecoverySafeErrorCode =
  | "SNAPSHOT_IO_FAILED"
  | "SOURCE_DRIFT"
  | "CANDIDATE_RECOVERY_FAILED"
  | "CANDIDATE_INVALID"
  | "METADATA_INVALID"
  | "DESTINATION_EXISTS"
  | "NOREPLACE_UNSUPPORTED"
  | "NOREPLACE_FAILED"
  | "FSYNC_FAILED";

const RECOVERY_STAGE_NAMES = [
  "snapshot-intent", "snapshot-complete", "candidate-validated",
  "quarantine-wal-intent", "wal-quarantined", "quarantine-shm-intent",
  "shm-quarantined", "quarantine-main-intent", "originals-quarantined",
  "publish-intent", "candidate-published", "public-verified",
  "cleanup-quarantine-wal-intent", "cleanup-quarantine-wal-done",
  "cleanup-quarantine-shm-intent", "cleanup-quarantine-shm-done",
  "cleanup-quarantine-main-intent", "cleanup-quarantine-main-done",
  "cleanup-snapshot-wal-intent", "cleanup-snapshot-wal-done",
  "cleanup-snapshot-shm-intent", "cleanup-snapshot-shm-done",
  "cleanup-snapshot-main-intent", "cleanup-snapshot-main-done",
  "complete-intent", "completed", "archive-intent", "archive-renamed",
  "archive-done", "marker-remove-intent", "marker-removed", "rollback-intent",
  "candidate-quarantine-intent", "candidate-quarantined", "restore-wal-intent",
  "wal-restored", "restore-shm-intent", "shm-restored", "restore-main-intent",
  "original-restored", "failed", "retry-intent",
  "retry-cleanup-candidate-quarantine-wal-intent",
  "retry-cleanup-candidate-quarantine-wal-done",
  "retry-cleanup-candidate-quarantine-shm-intent",
  "retry-cleanup-candidate-quarantine-shm-done",
  "retry-cleanup-candidate-quarantine-main-intent",
  "retry-cleanup-candidate-quarantine-main-done", "retry-snapshot-intent",
  "retry-reset-done",
  "snapshot-abort-candidate-temp-wal-intent",
  "snapshot-abort-candidate-temp-wal-done",
  "snapshot-abort-candidate-temp-shm-intent",
  "snapshot-abort-candidate-temp-shm-done",
  "snapshot-abort-candidate-temp-main-intent",
  "snapshot-abort-candidate-temp-main-done",
  "snapshot-abort-candidate-wal-intent", "snapshot-abort-candidate-wal-done",
  "snapshot-abort-candidate-shm-intent", "snapshot-abort-candidate-shm-done",
  "snapshot-abort-candidate-main-intent", "snapshot-abort-candidate-main-done",
  "snapshot-abort-snapshot-temp-wal-intent",
  "snapshot-abort-snapshot-temp-wal-done",
  "snapshot-abort-snapshot-temp-shm-intent",
  "snapshot-abort-snapshot-temp-shm-done",
  "snapshot-abort-snapshot-temp-main-intent",
  "snapshot-abort-snapshot-temp-main-done",
  "snapshot-abort-snapshot-wal-intent", "snapshot-abort-snapshot-wal-done",
  "snapshot-abort-snapshot-shm-intent", "snapshot-abort-snapshot-shm-done",
  "snapshot-abort-snapshot-main-intent", "snapshot-abort-snapshot-main-done",
  "aborted", "snapshot-retry-intent", "snapshot-retry-done"
] as const;

export type RecoveryStage = typeof RECOVERY_STAGE_NAMES[number];
export type RecoveryPhase =
  | "forward-precut"
  | "forward-postcut"
  | "archive-postcut"
  | "rollback-precut"
  | "retry-failed"
  | "snapshot-abort"
  | "retry-aborted"
  | "retry-reset";
export type RecoverySafeErrorPolicy = "null" | "detected-error" | "repeat-prior";

export interface RecoveryLayoutContext {
  readonly stage: RecoveryStage;
}

export interface RecoveryStageDefinition {
  readonly name: RecoveryStage;
  readonly phase: RecoveryPhase;
  readonly predecessors: readonly (RecoveryStage | "marker-only")[];
  readonly resolveLayout: (context: RecoveryLayoutContext) => RecoveryLayoutContext;
  readonly safeError: RecoverySafeErrorPolicy;
}

const abortStart = RECOVERY_STAGE_NAMES.indexOf("snapshot-abort-candidate-temp-wal-intent");
const phaseFor = (name: RecoveryStage): RecoveryPhase => {
  const index = RECOVERY_STAGE_NAMES.indexOf(name);
  if (index >= abortStart && name !== "snapshot-retry-intent" && name !== "snapshot-retry-done") {
    return "snapshot-abort";
  }
  if (name === "snapshot-retry-intent" || name === "snapshot-retry-done") return "retry-aborted";
  if (name === "retry-reset-done") return "retry-reset";
  if (index >= RECOVERY_STAGE_NAMES.indexOf("retry-intent") && index < abortStart) {
    return "retry-failed";
  }
  if (index >= RECOVERY_STAGE_NAMES.indexOf("rollback-intent")) return "rollback-precut";
  if (index >= RECOVERY_STAGE_NAMES.indexOf("archive-intent")) return "archive-postcut";
  if (index >= RECOVERY_STAGE_NAMES.indexOf("cleanup-quarantine-wal-intent")) {
    return "forward-postcut";
  }
  return "forward-precut";
};

const predecessorsFor = (name: RecoveryStage): readonly (RecoveryStage | "marker-only")[] => {
  if (name === "snapshot-intent") return ["marker-only", "snapshot-intent"];
  if (name === "candidate-validated") return ["snapshot-complete", "retry-reset-done"];
  if (name === "rollback-intent") {
    return RECOVERY_STAGE_NAMES.slice(
      RECOVERY_STAGE_NAMES.indexOf("snapshot-complete"),
      RECOVERY_STAGE_NAMES.indexOf("public-verified") + 1
    );
  }
  if (name === "retry-intent") return ["failed"];
  if (name === "snapshot-abort-candidate-temp-wal-intent") {
    return ["marker-only", "snapshot-intent"];
  }
  if (name === "snapshot-retry-intent") return ["aborted", "snapshot-retry-intent"];
  if (name === "retry-reset-done") return ["retry-snapshot-intent", "snapshot-retry-done"];
  const index = RECOVERY_STAGE_NAMES.indexOf(name);
  if (index <= 0) return ["marker-only"];
  return [RECOVERY_STAGE_NAMES[index - 1]!];
};

const errorPolicyFor = (name: RecoveryStage): RecoverySafeErrorPolicy => {
  if (name === "rollback-intent" || name === "snapshot-abort-candidate-temp-wal-intent") {
    return "detected-error";
  }
  const phase = phaseFor(name);
  if (
    phase === "rollback-precut"
    || phase === "retry-failed"
    || phase === "snapshot-abort"
    || phase === "retry-aborted"
  ) {
    return "repeat-prior";
  }
  return "null";
};

export const RECOVERY_STAGE_DEFINITIONS: readonly RecoveryStageDefinition[] =
  RECOVERY_STAGE_NAMES.map((name) => Object.freeze({
    name,
    phase: phaseFor(name),
    predecessors: Object.freeze([...predecessorsFor(name)]),
    resolveLayout: (context: RecoveryLayoutContext) => context,
    safeError: errorPolicyFor(name)
  }));

export interface ClaimedRecoveryLockLease extends GatewayDatabaseLockLease {
  readonly [claimedRecoveryLockBrand]: true;
  readonly databasePath: string;
}

export type GatewayRecoveryCommand =
  | { databasePath: string; action: "recover" }
  | { databasePath: string; action: "resume" | "retry"; operationId: string }
  | { databasePath: string; action: "status"; operationId?: string };

export type GatewayRecoveryStatusResult =
  | { kind: "status"; state: "initializing"; operationId: string | null }
  | { kind: "status"; state: "active"; operationId: string; stage: RecoveryStage }
  | {
      kind: "status";
      state: "completed";
      operationId: string;
      stage: "marker-remove-intent" | "marker-removed";
    };

export type GatewayRecoveryExecutionResult =
  | { kind: "execution"; status: "recovered"; operationId: string }
  | { kind: "execution"; status: "restored"; operationId: string }
  | { kind: "execution"; status: "aborted"; operationId: string }
  | { kind: "execution"; status: "blocked"; operationId: string };

export type GatewayRecoveryResult = GatewayRecoveryStatusResult | GatewayRecoveryExecutionResult;

export interface GatewayRecoveryRename {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface GatewayRecoveryDependencies {
  readonly randomBytes16: () => Uint8Array;
  readonly now: () => Date;
  readonly renameNoReplace: (input: GatewayRecoveryRename) => void;
  readonly validateImmutableV15: typeof validateImmutableGatewayV15Database;
  readonly fault: null | ((boundary: string) => void);
}

const fail = (code: string): never => {
  throw new Error(code);
};

const exactDatabasePath = (path: string): string => {
  if (!isAbsolute(path) || path === "/" || resolve(path) !== path) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return path;
};

const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export function createClaimedRecoveryLockLeaseForTest(
  lease: GatewayDatabaseLockLease & { databasePath: string }
): ClaimedRecoveryLockLease {
  if (process.env.NODE_ENV !== "test") return fail("GATEWAY_RECOVERY_LOCK_INVALID");
  const databasePath = exactDatabasePath(lease.databasePath);
  const lockPath = join(dirname(databasePath), ".family-ai-gateway.lock");
  let state: BigIntStats;
  try {
    state = lstatSync(lockPath, { bigint: true });
  } catch {
    return fail("GATEWAY_RECOVERY_LOCK_INVALID");
  }
  if (
    !state.isFile()
    || state.isSymbolicLink()
    || state.uid !== BigInt(process.getuid?.() ?? APP_UID)
    || state.gid !== BigInt(process.getgid?.() ?? APP_GID)
    || (state.mode & 0o777n) !== 0o600n
    || state.nlink !== 1n
    || state.dev !== lease.lockDev
    || state.ino !== lease.lockIno
  ) {
    return fail("GATEWAY_RECOVERY_LOCK_INVALID");
  }
  const claimed = {
    ...lease,
    databasePath,
    [claimedRecoveryLockBrand]: true as const
  };
  claimedRecoveryLeases.add(claimed);
  return claimed;
}

interface RecoveryMarker {
  version: 1;
  operationId: string;
  databaseBasename: string;
  workspaceBasename: "work";
  createdAt: string;
}

const readMarker = (databasePath: string): RecoveryMarker | undefined => {
  const activeRoot = join(dirname(databasePath), `.${basename(databasePath)}.wal-recovery`);
  let root: BigIntStats;
  try {
    root = lstatSync(activeRoot, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (
    !root.isDirectory()
    || root.isSymbolicLink()
    || root.uid !== BigInt(APP_UID)
    || root.gid !== BigInt(APP_GID)
    || (root.mode & 0o777n) !== 0o700n
    || realpathSync(activeRoot) !== activeRoot
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const children = readdirSync(activeRoot).toSorted();
  if (children.length === 0) return undefined;
  if (
    children.length > 2
    || children[0] !== "marker.json"
    || (children.length === 2 && children[1] !== "work")
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const markerPath = join(activeRoot, "marker.json");
  const markerState = lstatSync(markerPath, { bigint: true });
  if (
    !markerState.isFile()
    || markerState.isSymbolicLink()
    || markerState.uid !== BigInt(APP_UID)
    || markerState.gid !== BigInt(APP_GID)
    || markerState.nlink !== 1n
    || (markerState.mode & 0o777n) !== 0o600n
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const bytes = readFileSync(markerPath, "utf8");
  let marker: RecoveryMarker;
  try {
    marker = JSON.parse(bytes) as RecoveryMarker;
  } catch {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (
    JSON.stringify(marker) !== bytes
    || JSON.stringify(Object.keys(marker)) !== JSON.stringify([
      "version", "operationId", "databaseBasename", "workspaceBasename", "createdAt"
    ])
    || marker.version !== 1
    || !/^[0-9a-f]{32}$/u.test(marker.operationId)
    || marker.databaseBasename !== basename(databasePath)
    || marker.workspaceBasename !== "work"
    || Number.isNaN(Date.parse(marker.createdAt))
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return marker;
};

type Piece = "main" | "wal" | "shm";
const PIECES: readonly Piece[] = ["main", "wal", "shm"];
const PRIVATE_DIRECTORIES = [
  "receipts", "original", "candidate", "quarantine", "candidate-quarantine"
] as const;

interface RecoveryPaths {
  parent: string;
  databasePath: string;
  activeRoot: string;
  completedRoot: string;
  work: string;
  receipts: string;
  original: string;
  candidate: string;
  quarantine: string;
  candidateQuarantine: string;
}

type FileMetadata = {
  logicalBasename: string;
  dev: string;
  ino: string;
  size: string;
  uid: string;
  gid: string;
  mode: string;
  mtimeNs: string;
  initialCtimeNs: string;
  sha256: string;
};

type PieceManifest = Record<Piece, FileMetadata | null>;

interface RecoveryJournal {
  operationId: string;
  databaseBasename: string;
  paths: RecoveryPaths;
  sequence: number;
  prevHash: string | null;
  original: PieceManifest;
  candidateSha256: string | null;
  safeErrorCode: RecoverySafeErrorCode | null;
  rollbackFromStage: RecoveryStage | null;
  initialCtimes: Map<string, string>;
}

const pathsFor = (databasePath: string): RecoveryPaths => {
  const parent = dirname(databasePath);
  const file = basename(databasePath);
  const activeRoot = join(parent, `.${file}.wal-recovery`);
  const work = join(activeRoot, "work");
  return {
    parent,
    databasePath,
    activeRoot,
    completedRoot: join(parent, `.${file}.wal-recovery-completed`),
    work,
    receipts: join(work, "receipts"),
    original: join(work, "original"),
    candidate: join(work, "candidate"),
    quarantine: join(work, "quarantine"),
    candidateQuarantine: join(work, "candidate-quarantine")
  };
};

const pieceBasename = (databaseBasename: string, piece: Piece): string =>
  piece === "main" ? databaseBasename : `${databaseBasename}-${piece}`;

const piecePath = (directory: string, databaseBasename: string, piece: Piece): string =>
  join(directory, pieceBasename(databaseBasename, piece));

const tempPath = (
  directory: string,
  databaseBasename: string,
  operationId: string,
  piece: Piece
): string => join(directory, `.${databaseBasename}.${operationId}.${piece}.tmp`);

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const assertPrivateDirectory = (path: string): BigIntStats => {
  const state = lstatSync(path, { bigint: true });
  if (
    !state.isDirectory()
    || state.isSymbolicLink()
    || state.uid !== BigInt(APP_UID)
    || state.gid !== BigInt(APP_GID)
    || (state.mode & 0o777n) !== 0o700n
    || realpathSync(path) !== path
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return state;
};

const assertProtectedFile = (path: string): BigIntStats => {
  const state = lstatSync(path, { bigint: true });
  if (
    !state.isFile()
    || state.isSymbolicLink()
    || state.uid !== BigInt(APP_UID)
    || state.gid !== BigInt(APP_GID)
    || state.nlink !== 1n
    || (state.mode & 0o777n) !== 0o600n
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return state;
};

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const fileMetadata = (
  path: string,
  logicalBasename: string,
  initialCtimes: Map<string, string>
): FileMetadata => {
  const state = assertProtectedFile(path);
  const identity = `${state.dev}:${state.ino}`;
  const initialCtimeNs = initialCtimes.get(identity) ?? state.ctimeNs.toString();
  initialCtimes.set(identity, initialCtimeNs);
  return {
    logicalBasename,
    dev: state.dev.toString(),
    ino: state.ino.toString(),
    size: state.size.toString(),
    uid: state.uid.toString(),
    gid: state.gid.toString(),
    mode: (state.mode & 0o777n).toString(),
    mtimeNs: state.mtimeNs.toString(),
    initialCtimeNs,
    sha256: sha256File(path)
  };
};

const manifestForDirectory = (
  directory: string,
  databaseBasename: string,
  initialCtimes: Map<string, string>
): PieceManifest => Object.fromEntries(PIECES.map((piece) => {
  const path = piecePath(directory, databaseBasename, piece);
  return [piece, existsSync(path)
    ? fileMetadata(path, pieceBasename(databaseBasename, piece), initialCtimes)
    : null];
})) as PieceManifest;

const manifestForTemps = (
  directory: string,
  databaseBasename: string,
  operationId: string,
  initialCtimes: Map<string, string>
): PieceManifest => Object.fromEntries(PIECES.map((piece) => {
  const path = tempPath(directory, databaseBasename, operationId, piece);
  return [piece, existsSync(path)
    ? fileMetadata(path, basename(path), initialCtimes)
    : null];
})) as PieceManifest;

const workspaceMetadata = (journal: RecoveryJournal) => {
  const state = assertPrivateDirectory(journal.paths.work);
  const identity = `${state.dev}:${state.ino}`;
  const initialCtimeNs = journal.initialCtimes.get(identity) ?? state.ctimeNs.toString();
  journal.initialCtimes.set(identity, initialCtimeNs);
  return {
    logicalBasename: "work",
    dev: state.dev.toString(),
    ino: state.ino.toString(),
    uid: state.uid.toString(),
    gid: state.gid.toString(),
    mode: (state.mode & 0o777n).toString(),
    initialCtimeNs
  };
};

const appendReceipt = (
  journal: RecoveryJournal,
  stage: RecoveryStage,
  dependencies: GatewayRecoveryDependencies
): void => {
  journal.sequence += 1;
  const sequence = String(journal.sequence);
  const padded = sequence.padStart(20, "0");
  const receipt = {
    version: 1,
    sequence,
    prevHash: journal.prevHash,
    operationId: journal.operationId,
    stage,
    databaseBasename: journal.databaseBasename,
    workspace: workspaceMetadata(journal),
    original: journal.original,
    owned: {
      public: manifestForDirectory(
        journal.paths.parent,
        journal.databaseBasename,
        journal.initialCtimes
      ),
      snapshot: manifestForDirectory(
        journal.paths.original,
        journal.databaseBasename,
        journal.initialCtimes
      ),
      snapshotTemp: manifestForTemps(
        journal.paths.original,
        journal.databaseBasename,
        journal.operationId,
        journal.initialCtimes
      ),
      candidate: manifestForDirectory(
        journal.paths.candidate,
        journal.databaseBasename,
        journal.initialCtimes
      ),
      candidateTemp: manifestForTemps(
        journal.paths.candidate,
        journal.databaseBasename,
        journal.operationId,
        journal.initialCtimes
      ),
      quarantine: manifestForDirectory(
        journal.paths.quarantine,
        journal.databaseBasename,
        journal.initialCtimes
      ),
      candidateQuarantine: manifestForDirectory(
        journal.paths.candidateQuarantine,
        journal.databaseBasename,
        journal.initialCtimes
      )
    },
    candidateSha256: journal.candidateSha256,
    safeErrorCode: journal.safeErrorCode,
    rollbackFromStage: journal.rollbackFromStage
  };
  const bytes = JSON.stringify(receipt);
  const temp = join(
    journal.paths.receipts,
    `${journal.operationId}-${padded}-${stage}.json.tmp`
  );
  const final = join(journal.paths.receipts, `${padded}-${stage}.json`);
  const unpublished = readdirSync(journal.paths.receipts)
    .filter((name) => name.endsWith(".json.tmp"));
  if (
    unpublished.length > 1
    || (unpublished.length === 1 && unpublished[0] !== basename(temp))
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  let descriptor: number;
  if (existsSync(temp)) {
    const existing = readFileSync(temp, "utf8");
    if (existing !== bytes && !bytes.startsWith(existing)) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    descriptor = openSync(temp, constants.O_RDWR | constants.O_NOFOLLOW);
    ftruncateSync(descriptor, 0);
  } else {
    descriptor = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
  }
  try {
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(journal.paths.receipts);
  dependencies.fault?.(`receipt-temp:${stage}`);
  dependencies.renameNoReplace({ sourcePath: temp, destinationPath: final });
  fsyncDirectory(journal.paths.receipts);
  journal.prevHash = createHash("sha256").update(bytes).digest("hex");
  dependencies.fault?.(`receipt:${stage}`);
};

const moveNoReplace = (
  sourcePath: string,
  destinationPath: string,
  dependencies: GatewayRecoveryDependencies,
  boundary: string
): void => {
  dependencies.renameNoReplace({ sourcePath, destinationPath });
  fsyncDirectory(dirname(sourcePath));
  if (dirname(destinationPath) !== dirname(sourcePath)) {
    fsyncDirectory(dirname(destinationPath));
  }
  dependencies.fault?.(boundary);
};

const moveNoReplaceIdempotent = (
  sourcePath: string,
  destinationPath: string,
  dependencies: GatewayRecoveryDependencies,
  boundary: string
): void => {
  const sourceExists = existsSync(sourcePath);
  const destinationExists = existsSync(destinationPath);
  if (sourceExists && !destinationExists) {
    moveNoReplace(sourcePath, destinationPath, dependencies, boundary);
    return;
  }
  if (!sourceExists && destinationExists) {
    assertProtectedFile(destinationPath);
    return;
  }
  return fail("GATEWAY_RECOVERY_INVALID");
};

const validateImmutable = (
  databasePath: string,
  dependencies: GatewayRecoveryDependencies
): void => {
  const parentProofFd = openSync(
    dirname(databasePath),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  const databaseProofFd = openSync(
    databasePath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const parent = fstatSync(parentProofFd, { bigint: true });
    const database = fstatSync(databaseProofFd, { bigint: true });
    dependencies.validateImmutableV15({
      databasePath,
      parentProofFd,
      databaseProofFd,
      expectedParentIdentity: { dev: parent.dev, ino: parent.ino },
      expectedDatabaseIdentity: { dev: database.dev, ino: database.ino }
    });
  } finally {
    try {
      closeSync(databaseProofFd);
    } finally {
      closeSync(parentProofFd);
    }
  }
};

const initializeWork = (paths: RecoveryPaths): void => {
  if (!existsSync(paths.work)) {
    mkdirSync(paths.work, { mode: 0o700 });
    fsyncDirectory(paths.activeRoot);
  }
  assertPrivateDirectory(paths.work);
  for (const child of PRIVATE_DIRECTORIES) {
    const path = join(paths.work, child);
    if (!existsSync(path)) {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(paths.work);
    }
    assertPrivateDirectory(path);
  }
};

const useCompletedWork = (paths: RecoveryPaths, operationId: string): void => {
  const completed = join(paths.completedRoot, operationId);
  assertPrivateDirectory(completed);
  paths.work = completed;
  paths.receipts = join(completed, "receipts");
  paths.original = join(completed, "original");
  paths.candidate = join(completed, "candidate");
  paths.quarantine = join(completed, "quarantine");
  paths.candidateQuarantine = join(completed, "candidate-quarantine");
};

const journalFromMarker = (databasePath: string, marker: RecoveryMarker): RecoveryJournal => {
  const paths = pathsFor(databasePath);
  initializeWork(paths);
  const initialCtimes = new Map<string, string>();
  const original = manifestForDirectory(paths.parent, basename(databasePath), initialCtimes);
  if (PIECES.some((piece) => original[piece] === null)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return {
    operationId: marker.operationId,
    databaseBasename: marker.databaseBasename,
    paths,
    sequence: 0,
    prevHash: null,
    original,
    candidateSha256: null,
    safeErrorCode: null,
    rollbackFromStage: null,
    initialCtimes
  };
};

const createRecoveryJournal = (
  databasePath: string,
  operationId: string,
  createdAt: string,
  dependencies: GatewayRecoveryDependencies
): RecoveryJournal => {
  const paths = pathsFor(databasePath);
  mkdirSync(paths.completedRoot, { mode: 0o700 });
  chmodSync(paths.completedRoot, 0o700);
  fsyncDirectory(paths.parent);
  mkdirSync(paths.activeRoot, { mode: 0o700 });
  fsyncDirectory(paths.parent);
  const marker: RecoveryMarker = {
    version: 1,
    operationId,
    databaseBasename: basename(databasePath),
    workspaceBasename: "work",
    createdAt
  };
  const markerPath = join(paths.activeRoot, "marker.json");
  const markerDescriptor = openSync(
    markerPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(markerDescriptor, JSON.stringify(marker), "utf8");
    fsyncSync(markerDescriptor);
  } finally {
    closeSync(markerDescriptor);
  }
  fsyncDirectory(paths.activeRoot);
  dependencies.fault?.("marker-created");
  initializeWork(paths);
  const initialCtimes = new Map<string, string>();
  const original = manifestForDirectory(paths.parent, basename(databasePath), initialCtimes);
  if (PIECES.some((piece) => original[piece] === null)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return {
    operationId,
    databaseBasename: basename(databasePath),
    paths,
    sequence: 0,
    prevHash: null,
    original,
    candidateSha256: null,
    safeErrorCode: null,
    rollbackFromStage: null,
    initialCtimes
  };
};

const seedInitialCtimes = (value: unknown, target: Map<string, string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) seedInitialCtimes(item, target);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (
    typeof object.dev === "string"
    && typeof object.ino === "string"
    && typeof object.initialCtimeNs === "string"
  ) {
    target.set(`${object.dev}:${object.ino}`, object.initialCtimeNs);
  }
  for (const child of Object.values(object)) seedInitialCtimes(child, target);
};

const loadActiveJournal = (
  databasePath: string,
  marker: RecoveryMarker
): { journal: RecoveryJournal; lastStage: RecoveryStage | undefined } => {
  const paths = pathsFor(databasePath);
  if (existsSync(paths.work)) {
    initializeWork(paths);
  } else if (existsSync(join(paths.completedRoot, marker.operationId))) {
    useCompletedWork(paths, marker.operationId);
  } else {
    return { journal: journalFromMarker(databasePath, marker), lastStage: undefined };
  }
  const files = readdirSync(paths.receipts)
    .filter((name) => /^\d{20}-.+\.json$/u.test(name))
    .toSorted();
  if (files.length === 0) {
    return { journal: journalFromMarker(databasePath, marker), lastStage: undefined };
  }
  let expectedSequence = 1;
  let expectedPrevHash: string | null = null;
  let lastReceipt: Record<string, unknown> | undefined;
  let lastBytes = "";
  for (const file of files) {
    const bytes = readFileSync(join(paths.receipts, file), "utf8");
    const receipt = JSON.parse(bytes) as Record<string, unknown>;
    if (
      receipt.sequence !== String(expectedSequence)
      || receipt.prevHash !== expectedPrevHash
      || receipt.operationId !== marker.operationId
      || receipt.databaseBasename !== marker.databaseBasename
      || typeof receipt.stage !== "string"
      || !RECOVERY_STAGE_NAMES.includes(receipt.stage as RecoveryStage)
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    expectedPrevHash = createHash("sha256").update(bytes).digest("hex");
    expectedSequence += 1;
    lastReceipt = receipt;
    lastBytes = bytes;
  }
  if (!lastReceipt) return fail("GATEWAY_RECOVERY_INVALID");
  const initialCtimes = new Map<string, string>();
  seedInitialCtimes(lastReceipt.original, initialCtimes);
  seedInitialCtimes(lastReceipt.owned, initialCtimes);
  return {
    journal: {
      operationId: marker.operationId,
      databaseBasename: marker.databaseBasename,
      paths,
      sequence: expectedSequence - 1,
      prevHash: createHash("sha256").update(lastBytes).digest("hex"),
      original: lastReceipt.original as PieceManifest,
      candidateSha256: typeof lastReceipt.candidateSha256 === "string"
        ? lastReceipt.candidateSha256
        : null,
      safeErrorCode: typeof lastReceipt.safeErrorCode === "string"
        ? lastReceipt.safeErrorCode as RecoverySafeErrorCode
        : null,
      rollbackFromStage: typeof lastReceipt.rollbackFromStage === "string"
        ? lastReceipt.rollbackFromStage as RecoveryStage
        : null,
      initialCtimes
    },
    lastStage: lastReceipt.stage as RecoveryStage
  };
};

const publishSnapshotTemps = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  for (const piece of PIECES) {
    for (const directory of [journal.paths.original, journal.paths.candidate]) {
      const temporary = tempPath(directory, journal.databaseBasename, journal.operationId, piece);
      const final = piecePath(directory, journal.databaseBasename, piece);
      if (existsSync(temporary) && !existsSync(final)) {
        moveNoReplace(
          temporary,
          final,
          dependencies,
          `snapshot-publish:${basename(directory)}:${piece}`
        );
      } else if (existsSync(temporary) || !existsSync(final)) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
    }
  }
  appendReceipt(journal, "snapshot-complete", dependencies);
};

const copySnapshots = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  for (const piece of PIECES) {
    const source = piecePath(journal.paths.parent, journal.databaseBasename, piece);
    for (const directory of [journal.paths.original, journal.paths.candidate]) {
      const temporary = tempPath(
        directory,
        journal.databaseBasename,
        journal.operationId,
        piece
      );
      if (!existsSync(temporary)) {
        copyFileSync(source, temporary, constants.COPYFILE_EXCL);
        chmodSync(temporary, 0o600);
      } else if (sha256File(temporary) !== sha256File(source)) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(directory);
      dependencies.fault?.(`snapshot-copy:${basename(directory)}:${piece}`);
    }
  }
  appendReceipt(journal, "snapshot-intent", dependencies);
  publishSnapshotTemps(journal, dependencies);
};

const abortSnapshotFailure = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  code: RecoverySafeErrorCode
): void => {
  journal.safeErrorCode = code;
  journal.rollbackFromStage = null;
  const slots = [
    ["candidate-temp", journal.paths.candidate, true],
    ["candidate", journal.paths.candidate, false],
    ["snapshot-temp", journal.paths.original, true],
    ["snapshot", journal.paths.original, false]
  ] as const;
  for (const [slot, directory, temporary] of slots) {
    for (const piece of ["wal", "shm", "main"] as const) {
      const intent = `snapshot-abort-${slot}-${piece}-intent` as RecoveryStage;
      const done = `snapshot-abort-${slot}-${piece}-done` as RecoveryStage;
      appendReceipt(journal, intent, dependencies);
      const path = temporary
        ? tempPath(directory, journal.databaseBasename, journal.operationId, piece)
        : piecePath(directory, journal.databaseBasename, piece);
      if (existsSync(path)) unlinkSync(path);
      fsyncDirectory(directory);
      appendReceipt(journal, done, dependencies);
    }
  }
  appendReceipt(journal, "aborted", dependencies);
};

const retryAbortedRecovery = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  if (!journal.safeErrorCode || journal.rollbackFromStage !== null) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  appendReceipt(journal, "snapshot-retry-intent", dependencies);
  for (const piece of PIECES) {
    const source = piecePath(journal.paths.parent, journal.databaseBasename, piece);
    for (const directory of [journal.paths.original, journal.paths.candidate]) {
      const temporary = tempPath(
        directory,
        journal.databaseBasename,
        journal.operationId,
        piece
      );
      copyFileSync(source, temporary, constants.COPYFILE_EXCL);
      chmodSync(temporary, 0o600);
      const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      moveNoReplace(
        temporary,
        piecePath(directory, journal.databaseBasename, piece),
        dependencies,
        `snapshot-retry:${basename(directory)}:${piece}`
      );
    }
  }
  appendReceipt(journal, "snapshot-retry-done", dependencies);
  journal.safeErrorCode = null;
  journal.rollbackFromStage = null;
  journal.candidateSha256 = null;
  appendReceipt(journal, "retry-reset-done", dependencies);
};

const snapshotAbortPath = (
  journal: RecoveryJournal,
  stage: RecoveryStage
): string => {
  const match = stage.match(
    /^snapshot-abort-(candidate-temp|candidate|snapshot-temp|snapshot)-(wal|shm|main)-intent$/u
  );
  if (!match) return fail("GATEWAY_RECOVERY_INVALID");
  const [, slot, piece] = match as [string, string, Piece];
  const candidate = slot.startsWith("candidate");
  const temporary = slot.endsWith("temp");
  const directory = candidate ? journal.paths.candidate : journal.paths.original;
  return temporary
    ? tempPath(directory, journal.databaseBasename, journal.operationId, piece)
    : piecePath(directory, journal.databaseBasename, piece);
};

const continueSnapshotAbort = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  startingStage: RecoveryStage
): "aborted" => {
  if (!journal.safeErrorCode || journal.rollbackFromStage !== null) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const order = RECOVERY_STAGE_NAMES.slice(
    abortStart,
    RECOVERY_STAGE_NAMES.indexOf("aborted") + 1
  );
  let current = startingStage;
  while (current !== "aborted") {
    const index = order.indexOf(current);
    if (index < 0) return fail("GATEWAY_RECOVERY_INVALID");
    if (current.endsWith("-intent")) {
      const path = snapshotAbortPath(journal, current);
      if (existsSync(path)) unlinkSync(path);
      fsyncDirectory(dirname(path));
      const done = order[index + 1];
      if (!done) return fail("GATEWAY_RECOVERY_INVALID");
      appendReceipt(journal, done, dependencies);
      current = done;
    } else {
      const next = order[index + 1];
      if (!next) return fail("GATEWAY_RECOVERY_INVALID");
      appendReceipt(journal, next, dependencies);
      current = next;
    }
  }
  return current;
};

const continueRollback = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  startingStage: RecoveryStage
): "failed" => {
  if (!journal.safeErrorCode || !journal.rollbackFromStage) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  let current = startingStage;
  if (current === "rollback-intent") {
    appendReceipt(journal, "candidate-quarantine-intent", dependencies);
    current = "candidate-quarantine-intent";
  }
  if (current === "candidate-quarantine-intent") {
    for (const piece of PIECES) {
      const source = piecePath(journal.paths.candidate, journal.databaseBasename, piece);
      const destination = piecePath(
        journal.paths.candidateQuarantine,
        journal.databaseBasename,
        piece
      );
      if (existsSync(source)) {
        moveNoReplaceIdempotent(
          source,
          destination,
          dependencies,
          `candidate-quarantine:${piece}`
        );
      }
    }
    appendReceipt(journal, "candidate-quarantined", dependencies);
    current = "candidate-quarantined";
  }
  const restores = [
    ["wal", "candidate-quarantined", "restore-wal-intent", "wal-restored"],
    ["shm", "wal-restored", "restore-shm-intent", "shm-restored"],
    ["main", "shm-restored", "restore-main-intent", "original-restored"]
  ] as const;
  for (const [piece, previous, intent, done] of restores) {
    const order: readonly RecoveryStage[] = [previous, intent, done];
    if (current !== previous && current !== intent && current !== done) continue;
    if (current === previous) {
      appendReceipt(journal, intent, dependencies);
      current = intent;
    }
    if (current === intent) {
      if (!originalPieceMatches(journal, piece)) {
        const publicPath = piecePath(journal.paths.parent, journal.databaseBasename, piece);
        const quarantinePath = piecePath(journal.paths.quarantine, journal.databaseBasename, piece);
        if (!existsSync(publicPath) && existsSync(quarantinePath)) {
          moveNoReplaceIdempotent(
            quarantinePath,
            publicPath,
            dependencies,
            `restore:${piece}`
          );
        } else {
          return fail("GATEWAY_RECOVERY_INVALID");
        }
      }
      appendReceipt(journal, done, dependencies);
      current = done;
    }
    if (!order.includes(current)) return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (current === "original-restored") {
    appendReceipt(journal, "failed", dependencies);
    current = "failed";
  }
  if (current !== "failed") return fail("GATEWAY_RECOVERY_INVALID");
  return current;
};

const recoverCandidate = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  const candidatePath = piecePath(journal.paths.candidate, journal.databaseBasename, "main");
  const database = new Database(candidatePath, { fileMustExist: true });
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
  } finally {
    database.close();
  }
  for (const piece of ["wal", "shm"] as const) {
    const path = piecePath(journal.paths.candidate, journal.databaseBasename, piece);
    if (existsSync(path)) unlinkSync(path);
  }
  fsyncDirectory(journal.paths.candidate);
  chmodSync(candidatePath, 0o600);
  validateImmutable(candidatePath, dependencies);
  journal.candidateSha256 = sha256File(candidatePath);
  appendReceipt(journal, "candidate-validated", dependencies);
};

const originalPieceMatches = (journal: RecoveryJournal, piece: Piece): boolean => {
  const expected = journal.original[piece];
  if (!expected) return false;
  const path = piecePath(journal.paths.parent, journal.databaseBasename, piece);
  if (!existsSync(path)) return false;
  const state = assertProtectedFile(path);
  return state.dev.toString() === expected.dev
    && state.ino.toString() === expected.ino
    && state.size.toString() === expected.size
    && sha256File(path) === expected.sha256;
};

const assertPublicOriginalExact = (journal: RecoveryJournal): void => {
  for (const piece of PIECES) {
    const expected = journal.original[piece];
    const path = piecePath(journal.paths.parent, journal.databaseBasename, piece);
    if (!expected || !existsSync(path)) return fail("GATEWAY_RECOVERY_INVALID");
    const state = assertProtectedFile(path);
    if (
      state.dev.toString() !== expected.dev
      || state.ino.toString() !== expected.ino
      || state.size.toString() !== expected.size
      || state.uid.toString() !== expected.uid
      || state.gid.toString() !== expected.gid
      || (state.mode & 0o777n).toString() !== expected.mode
      || state.mtimeNs.toString() !== expected.mtimeNs
      || sha256File(path) !== expected.sha256
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
  }
};

const rollbackCandidateFailure = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  code: RecoverySafeErrorCode
): void => {
  journal.safeErrorCode = code;
  journal.rollbackFromStage = "snapshot-complete";
  appendReceipt(journal, "rollback-intent", dependencies);
  appendReceipt(journal, "candidate-quarantine-intent", dependencies);
  for (const piece of PIECES) {
    const source = piecePath(journal.paths.candidate, journal.databaseBasename, piece);
    const destination = piecePath(
      journal.paths.candidateQuarantine,
      journal.databaseBasename,
      piece
    );
    if (existsSync(source)) {
      moveNoReplaceIdempotent(
        source,
        destination,
        dependencies,
        `candidate-quarantine:${piece}`
      );
    }
  }
  appendReceipt(journal, "candidate-quarantined", dependencies);
  const restores = [
    ["wal", "restore-wal-intent", "wal-restored"],
    ["shm", "restore-shm-intent", "shm-restored"],
    ["main", "restore-main-intent", "original-restored"]
  ] as const;
  for (const [piece, intent, done] of restores) {
    appendReceipt(journal, intent, dependencies);
    if (!originalPieceMatches(journal, piece)) {
      const publicPath = piecePath(journal.paths.parent, journal.databaseBasename, piece);
      const quarantinePath = piecePath(journal.paths.quarantine, journal.databaseBasename, piece);
      if (!existsSync(publicPath) && existsSync(quarantinePath)) {
        moveNoReplaceIdempotent(
          quarantinePath,
          publicPath,
          dependencies,
          `restore:${piece}`
        );
      } else {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
    }
    appendReceipt(journal, done, dependencies);
  }
  appendReceipt(journal, "failed", dependencies);
};

const retryFailedRecovery = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  if (!journal.safeErrorCode || !journal.rollbackFromStage) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  appendReceipt(journal, "retry-intent", dependencies);
  const cleanup = [
    ["wal", "retry-cleanup-candidate-quarantine-wal-intent",
      "retry-cleanup-candidate-quarantine-wal-done"],
    ["shm", "retry-cleanup-candidate-quarantine-shm-intent",
      "retry-cleanup-candidate-quarantine-shm-done"],
    ["main", "retry-cleanup-candidate-quarantine-main-intent",
      "retry-cleanup-candidate-quarantine-main-done"]
  ] as const;
  for (const [piece, intent, done] of cleanup) {
    appendReceipt(journal, intent, dependencies);
    const path = piecePath(journal.paths.candidateQuarantine, journal.databaseBasename, piece);
    if (existsSync(path)) unlinkSync(path);
    fsyncDirectory(journal.paths.candidateQuarantine);
    appendReceipt(journal, done, dependencies);
  }
  appendReceipt(journal, "retry-snapshot-intent", dependencies);
  for (const piece of PIECES) {
    const source = piecePath(journal.paths.original, journal.databaseBasename, piece);
    const temporary = tempPath(
      journal.paths.candidate,
      journal.databaseBasename,
      journal.operationId,
      piece
    );
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    moveNoReplace(
      temporary,
      piecePath(journal.paths.candidate, journal.databaseBasename, piece),
      dependencies,
      `retry-snapshot:${piece}`
    );
  }
  journal.safeErrorCode = null;
  journal.rollbackFromStage = null;
  journal.candidateSha256 = null;
  appendReceipt(journal, "retry-reset-done", dependencies);
};

const continueInstallCandidate = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  startingStage: RecoveryStage
): "public-verified" => {
  const quarantineStages = [
    ["wal", "quarantine-wal-intent", "wal-quarantined"],
    ["shm", "quarantine-shm-intent", "shm-quarantined"],
    ["main", "quarantine-main-intent", "originals-quarantined"]
  ] as const;
  const installOrder: readonly RecoveryStage[] = [
    "candidate-validated",
    "quarantine-wal-intent", "wal-quarantined",
    "quarantine-shm-intent", "shm-quarantined",
    "quarantine-main-intent", "originals-quarantined",
    "publish-intent", "candidate-published", "public-verified"
  ];
  let current: RecoveryStage = startingStage;
  let previous: RecoveryStage = "candidate-validated";
  for (const [piece, intent, done] of quarantineStages) {
    if (installOrder.indexOf(current) > installOrder.indexOf(done)) {
      previous = done;
      continue;
    }
    if (current === previous) {
      appendReceipt(journal, intent, dependencies);
      current = intent;
    }
    if (current === intent) {
      moveNoReplaceIdempotent(
        piecePath(journal.paths.parent, journal.databaseBasename, piece),
        piecePath(journal.paths.quarantine, journal.databaseBasename, piece),
        dependencies,
        `quarantine:${piece}`
      );
      appendReceipt(journal, done, dependencies);
      current = done;
    }
    if (current !== done) return fail("GATEWAY_RECOVERY_INVALID");
    previous = done;
  }
  if (current === "originals-quarantined") {
    appendReceipt(journal, "publish-intent", dependencies);
    current = "publish-intent";
  }
  if (current === "publish-intent") {
    moveNoReplaceIdempotent(
      piecePath(journal.paths.candidate, journal.databaseBasename, "main"),
      journal.paths.databasePath,
      dependencies,
      "publish:candidate"
    );
    appendReceipt(journal, "candidate-published", dependencies);
    current = "candidate-published";
  }
  if (current === "candidate-published") {
    validateImmutable(journal.paths.databasePath, dependencies);
    appendReceipt(journal, "public-verified", dependencies);
    current = "public-verified";
  }
  if (current !== "public-verified") return fail("GATEWAY_RECOVERY_INVALID");
  return current;
};

const installCandidate = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  continueInstallCandidate(journal, dependencies, "candidate-validated");
};

const continueCleanupInstalled = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  startingStage: RecoveryStage
): "completed" => {
  const cleanup = [
    [journal.paths.quarantine, "wal", "cleanup-quarantine-wal-intent", "cleanup-quarantine-wal-done"],
    [journal.paths.quarantine, "shm", "cleanup-quarantine-shm-intent", "cleanup-quarantine-shm-done"],
    [journal.paths.quarantine, "main", "cleanup-quarantine-main-intent", "cleanup-quarantine-main-done"],
    [journal.paths.original, "wal", "cleanup-snapshot-wal-intent", "cleanup-snapshot-wal-done"],
    [journal.paths.original, "shm", "cleanup-snapshot-shm-intent", "cleanup-snapshot-shm-done"],
    [journal.paths.original, "main", "cleanup-snapshot-main-intent", "cleanup-snapshot-main-done"]
  ] as const;
  const cleanupOrder: readonly RecoveryStage[] = [
    "public-verified",
    ...cleanup.flatMap(([, , intent, done]) => [intent, done]),
    "complete-intent", "completed"
  ];
  let current: RecoveryStage = startingStage;
  let previous: RecoveryStage = "public-verified";
  for (const [directory, piece, intent, done] of cleanup) {
    if (cleanupOrder.indexOf(current) > cleanupOrder.indexOf(done)) {
      previous = done;
      continue;
    }
    if (current === previous) {
      appendReceipt(journal, intent, dependencies);
      current = intent;
    }
    if (current === intent) {
      const path = piecePath(directory, journal.databaseBasename, piece);
      if (existsSync(path)) unlinkSync(path);
      fsyncDirectory(directory);
      dependencies.fault?.(`cleanup:${intent}`);
      appendReceipt(journal, done, dependencies);
      current = done;
    }
    if (current !== done) return fail("GATEWAY_RECOVERY_INVALID");
    previous = done;
  }
  if (current === "cleanup-snapshot-main-done") {
    appendReceipt(journal, "complete-intent", dependencies);
    current = "complete-intent";
  }
  if (current === "complete-intent") {
    appendReceipt(journal, "completed", dependencies);
    current = "completed";
  }
  if (current !== "completed") return fail("GATEWAY_RECOVERY_INVALID");
  return current;
};

const cleanupInstalled = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  continueCleanupInstalled(journal, dependencies, "public-verified");
};

const continueArchiveCompleted = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  startingStage: RecoveryStage
): "marker-removed" => {
  let current: RecoveryStage = startingStage;
  const completed = join(journal.paths.completedRoot, journal.operationId);
  if (current === "completed") {
    appendReceipt(journal, "archive-intent", dependencies);
    current = "archive-intent";
  }
  if (current === "archive-intent") {
    if (journal.paths.work === completed && existsSync(completed)) {
      assertPrivateDirectory(completed);
    } else if (existsSync(journal.paths.work) && !existsSync(completed)) {
      moveNoReplace(journal.paths.work, completed, dependencies, "archive:work");
    } else if (!existsSync(journal.paths.work) && existsSync(completed)) {
      assertPrivateDirectory(completed);
    } else {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    useCompletedWork(journal.paths, journal.operationId);
    appendReceipt(journal, "archive-renamed", dependencies);
    current = "archive-renamed";
  } else if (existsSync(completed)) {
    useCompletedWork(journal.paths, journal.operationId);
  }
  if (current === "archive-renamed") {
    appendReceipt(journal, "archive-done", dependencies);
    current = "archive-done";
  }
  if (current === "archive-done") {
    validateImmutable(journal.paths.databasePath, dependencies);
    appendReceipt(journal, "marker-remove-intent", dependencies);
    current = "marker-remove-intent";
  }
  if (current === "marker-remove-intent") {
    const markerPath = join(journal.paths.activeRoot, "marker.json");
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
      fsyncDirectory(journal.paths.activeRoot);
      dependencies.fault?.("marker-unlinked");
    }
    if (existsSync(journal.paths.activeRoot)) {
      if (readdirSync(journal.paths.activeRoot).length !== 0) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      rmdirSync(journal.paths.activeRoot);
      fsyncDirectory(journal.paths.parent);
      dependencies.fault?.("active-root-removed");
    }
    appendReceipt(journal, "marker-removed", dependencies);
    current = "marker-removed";
  }
  if (current !== "marker-removed") return fail("GATEWAY_RECOVERY_INVALID");
  return current;
};

const archiveCompleted = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  continueArchiveCompleted(journal, dependencies, "completed");
};

const operationIdFromDependencies = (dependencies: GatewayRecoveryDependencies): string => {
  const bytes = dependencies.randomBytes16();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return Buffer.from(bytes).toString("hex");
};

const lastCompletedStage = (
  databasePath: string,
  operationId: string
): "marker-remove-intent" | "marker-removed" | undefined => {
  const receipts = join(
    pathsFor(databasePath).completedRoot,
    operationId,
    "receipts"
  );
  if (!existsSync(receipts)) return undefined;
  const files = readdirSync(receipts)
    .filter((name) => /^\d{20}-.+\.json$/u.test(name))
    .toSorted();
  const last = files.at(-1);
  if (!last) return undefined;
  let receipt: { operationId?: unknown; stage?: unknown };
  try {
    const bytes = readFileSync(join(receipts, last), "utf8");
    receipt = JSON.parse(bytes) as { operationId?: unknown; stage?: unknown };
  } catch {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (receipt.operationId !== operationId) return fail("GATEWAY_RECOVERY_INVALID");
  if (receipt.stage === "marker-remove-intent" || receipt.stage === "marker-removed") {
    return receipt.stage;
  }
  return undefined;
};

const completedOperationIds = (databasePath: string): string[] => {
  const completedRoot = pathsFor(databasePath).completedRoot;
  if (!existsSync(completedRoot)) return [];
  assertPrivateDirectory(completedRoot);
  return readdirSync(completedRoot)
    .filter((name) => /^[0-9a-f]{32}$/u.test(name) && lastCompletedStage(databasePath, name))
    .toSorted();
};

export function runGatewayRecoveryWithLease(
  lease: ClaimedRecoveryLockLease,
  input: GatewayRecoveryCommand,
  dependencies: GatewayRecoveryDependencies
): GatewayRecoveryResult {
  const databasePath = exactDatabasePath(input.databasePath);
  if (
    !claimedRecoveryLeases.has(lease)
    || lease.databasePath !== databasePath
  ) {
    return fail("GATEWAY_RECOVERY_LOCK_INVALID");
  }
  if (
    "operationId" in input
    && input.operationId !== undefined
    && !/^[0-9a-f]{32}$/u.test(input.operationId)
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (input.action === "recover") {
    if (existsSync(pathsFor(databasePath).activeRoot)) {
      return fail("GATEWAY_RECOVERY_RESUME_REQUIRED");
    }
    const operationId = operationIdFromDependencies(dependencies);
    const createdAt = dependencies.now().toISOString();
    const journal = createRecoveryJournal(databasePath, operationId, createdAt, dependencies);
    try {
      copySnapshots(journal, dependencies);
    } catch (error) {
      if (error instanceof Error && error.message === "SNAPSHOT_IO_FAILED") {
        abortSnapshotFailure(journal, dependencies, "SNAPSHOT_IO_FAILED");
        return { kind: "execution", status: "aborted", operationId };
      }
      throw error;
    }
    try {
      recoverCandidate(journal, dependencies);
    } catch (error) {
      if (error instanceof Error && error.message === "SIMULATED_SIGKILL") throw error;
      rollbackCandidateFailure(
        journal,
        dependencies,
        error instanceof Error && error.message === "CANDIDATE_INVALID"
          ? "CANDIDATE_INVALID"
          : "CANDIDATE_RECOVERY_FAILED"
      );
      return { kind: "execution", status: "restored", operationId };
    }
    installCandidate(journal, dependencies);
    cleanupInstalled(journal, dependencies);
    archiveCompleted(journal, dependencies);
    return { kind: "execution", status: "recovered", operationId };
  }
  const marker = readMarker(databasePath);
  if (!marker) {
    const operationIds = input.operationId === undefined
      ? completedOperationIds(databasePath)
      : [input.operationId];
    const completed = operationIds
      .map((operationId) => ({ operationId, stage: lastCompletedStage(databasePath, operationId) }))
      .filter((candidate): candidate is {
        operationId: string;
        stage: "marker-remove-intent" | "marker-removed";
      } => candidate.stage !== undefined);
    if (completed.length === 1) {
      const terminal = completed[0]!;
      validateImmutable(databasePath, dependencies);
      if (input.action === "resume") {
        if (terminal.stage === "marker-remove-intent") {
          const loaded = loadActiveJournal(databasePath, {
            version: 1,
            operationId: terminal.operationId,
            databaseBasename: basename(databasePath),
            workspaceBasename: "work",
            createdAt: dependencies.now().toISOString()
          });
          continueArchiveCompleted(
            loaded.journal,
            dependencies,
            "marker-remove-intent"
          );
        }
        return {
          kind: "execution",
          status: "recovered",
          operationId: terminal.operationId
        };
      }
      if (input.action === "status") {
        return {
          kind: "status",
          state: "completed",
          operationId: terminal.operationId,
          stage: terminal.stage
        };
      }
    }
    if (completed.length > 1) return fail("GATEWAY_RECOVERY_INVALID");
    if (input.action !== "status") return fail("GATEWAY_RECOVERY_INVALID");
    if (!existsSync(pathsFor(databasePath).activeRoot)) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    return {
      kind: "status",
      state: "initializing",
      operationId: null
    };
  }
  if (input.operationId !== undefined && input.operationId !== marker.operationId) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (input.action === "resume" || input.action === "retry") {
    const loaded = loadActiveJournal(databasePath, marker);
    const { journal } = loaded;
    let current = loaded.lastStage;
    if (
      current !== undefined
      && new Set<RecoveryStage>([
        "snapshot-intent", "snapshot-complete", "candidate-validated",
        "quarantine-wal-intent"
      ]).has(current)
    ) {
      assertPublicOriginalExact(journal);
    }
    if (
      current !== undefined
      && RECOVERY_STAGE_NAMES.slice(
        abortStart,
        RECOVERY_STAGE_NAMES.indexOf("aborted")
      ).includes(current)
    ) {
      continueSnapshotAbort(journal, dependencies, current);
      current = "aborted";
    }
    const rollbackStages = new Set<RecoveryStage>([
      "rollback-intent", "candidate-quarantine-intent", "candidate-quarantined",
      "restore-wal-intent", "wal-restored", "restore-shm-intent", "shm-restored",
      "restore-main-intent", "original-restored"
    ]);
    if (current !== undefined && rollbackStages.has(current)) {
      continueRollback(journal, dependencies, current);
      current = "failed";
    }
    if (current === "aborted") {
      if (input.action === "resume") {
        return {
          kind: "execution",
          status: "aborted",
          operationId: marker.operationId
        };
      }
      retryAbortedRecovery(journal, dependencies);
      current = "retry-reset-done";
    } else if (current === "failed") {
      if (input.action === "resume") {
        return {
          kind: "execution",
          status: "restored",
          operationId: marker.operationId
        };
      }
      retryFailedRecovery(journal, dependencies);
      current = "retry-reset-done";
    } else if (input.action === "retry") {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    if (current === undefined) {
      copySnapshots(journal, dependencies);
      current = "snapshot-complete";
    } else if (current === "snapshot-intent") {
      publishSnapshotTemps(journal, dependencies);
      current = "snapshot-complete";
    }
    if (current === "snapshot-complete" || current === "retry-reset-done") {
      recoverCandidate(journal, dependencies);
      current = "candidate-validated";
    }
    const installStages = new Set<RecoveryStage>([
      "candidate-validated",
      "quarantine-wal-intent", "wal-quarantined",
      "quarantine-shm-intent", "shm-quarantined",
      "quarantine-main-intent", "originals-quarantined",
      "publish-intent", "candidate-published", "public-verified"
    ]);
    if (installStages.has(current)) {
      current = continueInstallCandidate(journal, dependencies, current);
    }
    const cleanupStages = new Set<RecoveryStage>([
      "public-verified",
      "cleanup-quarantine-wal-intent", "cleanup-quarantine-wal-done",
      "cleanup-quarantine-shm-intent", "cleanup-quarantine-shm-done",
      "cleanup-quarantine-main-intent", "cleanup-quarantine-main-done",
      "cleanup-snapshot-wal-intent", "cleanup-snapshot-wal-done",
      "cleanup-snapshot-shm-intent", "cleanup-snapshot-shm-done",
      "cleanup-snapshot-main-intent", "cleanup-snapshot-main-done",
      "complete-intent", "completed"
    ]);
    if (cleanupStages.has(current)) {
      current = continueCleanupInstalled(journal, dependencies, current);
    }
    const archiveStages = new Set<RecoveryStage>([
      "completed", "archive-intent", "archive-renamed", "archive-done",
      "marker-remove-intent", "marker-removed"
    ]);
    if (!archiveStages.has(current)) return fail("GATEWAY_RECOVERY_NOT_IMPLEMENTED");
    continueArchiveCompleted(journal, dependencies, current);
    return {
      kind: "execution",
      status: "recovered",
      operationId: marker.operationId
    };
  }
  if (input.action !== "status") return fail("GATEWAY_RECOVERY_NOT_IMPLEMENTED");
  const receipts = join(pathsFor(databasePath).work, "receipts");
  if (existsSync(receipts)) {
    const files = readdirSync(receipts)
      .filter((name) => /^\d{20}-.+\.json$/u.test(name))
      .toSorted();
    const last = files.at(-1);
    if (last) {
      const receipt = JSON.parse(readFileSync(join(receipts, last), "utf8")) as {
        stage?: RecoveryStage;
      };
      if (!RECOVERY_STAGE_NAMES.includes(receipt.stage as RecoveryStage)) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      return {
        kind: "status",
        state: "active",
        operationId: marker.operationId,
        stage: receipt.stage!
      };
    }
  }
  return {
    kind: "status",
    state: "initializing",
    operationId: marker.operationId
  };
}
