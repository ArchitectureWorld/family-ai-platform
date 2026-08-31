import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
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

const fail = (code: string): never => {
  throw new Error(code);
};

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

const defineStage = <
  const Name extends string,
  const Predecessor extends string
>(
  name: Name,
  phase: RecoveryPhase,
  predecessors: readonly Predecessor[],
  safeError: RecoverySafeErrorPolicy
) => {
  const sealedPredecessors = Object.freeze([...predecessors]);
  return Object.freeze({
    name,
    phase,
    predecessors: sealedPredecessors,
    resolveLayout: (context: {
      readonly stage: string;
      readonly predecessor: string;
      readonly validateLayout?: () => void;
    }) => {
      if (context.stage !== name || !sealedPredecessors.includes(context.predecessor as Predecessor)) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      context.validateLayout?.();
      return context;
    },
    safeError
  });
};

const ROLLBACK_FORWARD_STAGES = [
  "snapshot-complete", "candidate-validated", "quarantine-wal-intent", "wal-quarantined",
  "quarantine-shm-intent", "shm-quarantined", "quarantine-main-intent",
  "originals-quarantined", "publish-intent", "candidate-published", "public-verified"
] as const;

const ABORT_SLOTS = ["candidate-temp", "candidate", "snapshot-temp", "snapshot"] as const;
const ABORT_PIECES = ["wal", "shm", "main"] as const;
const abortDefinitions = ABORT_SLOTS.flatMap((slot, slotIndex) =>
  ABORT_PIECES.flatMap((piece, pieceIndex) => {
    const intent = `snapshot-abort-${slot}-${piece}-intent` as const;
    const done = `snapshot-abort-${slot}-${piece}-done` as const;
    const previous = slotIndex === 0 && pieceIndex === 0
      ? (["marker-only", "snapshot-intent"] as const)
      : ([
          pieceIndex > 0
            ? `snapshot-abort-${slot}-${ABORT_PIECES[pieceIndex - 1]}-done`
            : `snapshot-abort-${ABORT_SLOTS[slotIndex - 1]}-main-done`
        ] as const);
    return [
      defineStage(
        intent,
        "snapshot-abort",
        previous,
        slotIndex === 0 && pieceIndex === 0 ? "detected-error" : "repeat-prior"
      ),
      defineStage(done, "snapshot-abort", [intent], "repeat-prior")
    ] as const;
  })
);

export const RECOVERY_STAGE_DEFINITIONS = Object.freeze([
  defineStage("snapshot-intent", "forward-precut", ["marker-only", "snapshot-intent"], "null"),
  defineStage("snapshot-complete", "forward-precut", ["snapshot-intent"], "null"),
  defineStage(
    "candidate-validated",
    "forward-precut",
    ["snapshot-complete", "retry-reset-done"],
    "null"
  ),
  defineStage("quarantine-wal-intent", "forward-precut", ["candidate-validated"], "null"),
  defineStage("wal-quarantined", "forward-precut", ["quarantine-wal-intent"], "null"),
  defineStage("quarantine-shm-intent", "forward-precut", ["wal-quarantined"], "null"),
  defineStage("shm-quarantined", "forward-precut", ["quarantine-shm-intent"], "null"),
  defineStage("quarantine-main-intent", "forward-precut", ["shm-quarantined"], "null"),
  defineStage("originals-quarantined", "forward-precut", ["quarantine-main-intent"], "null"),
  defineStage("publish-intent", "forward-precut", ["originals-quarantined"], "null"),
  defineStage("candidate-published", "forward-precut", ["publish-intent"], "null"),
  defineStage("public-verified", "forward-precut", ["candidate-published"], "null"),
  defineStage("cleanup-quarantine-wal-intent", "forward-postcut", ["public-verified"], "null"),
  defineStage(
    "cleanup-quarantine-wal-done",
    "forward-postcut",
    ["cleanup-quarantine-wal-intent"],
    "null"
  ),
  defineStage(
    "cleanup-quarantine-shm-intent",
    "forward-postcut",
    ["cleanup-quarantine-wal-done"],
    "null"
  ),
  defineStage(
    "cleanup-quarantine-shm-done",
    "forward-postcut",
    ["cleanup-quarantine-shm-intent"],
    "null"
  ),
  defineStage(
    "cleanup-quarantine-main-intent",
    "forward-postcut",
    ["cleanup-quarantine-shm-done"],
    "null"
  ),
  defineStage(
    "cleanup-quarantine-main-done",
    "forward-postcut",
    ["cleanup-quarantine-main-intent"],
    "null"
  ),
  defineStage(
    "cleanup-snapshot-wal-intent",
    "forward-postcut",
    ["cleanup-quarantine-main-done"],
    "null"
  ),
  defineStage("cleanup-snapshot-wal-done", "forward-postcut", ["cleanup-snapshot-wal-intent"], "null"),
  defineStage("cleanup-snapshot-shm-intent", "forward-postcut", ["cleanup-snapshot-wal-done"], "null"),
  defineStage("cleanup-snapshot-shm-done", "forward-postcut", ["cleanup-snapshot-shm-intent"], "null"),
  defineStage("cleanup-snapshot-main-intent", "forward-postcut", ["cleanup-snapshot-shm-done"], "null"),
  defineStage("cleanup-snapshot-main-done", "forward-postcut", ["cleanup-snapshot-main-intent"], "null"),
  defineStage("complete-intent", "forward-postcut", ["cleanup-snapshot-main-done"], "null"),
  defineStage("completed", "forward-postcut", ["complete-intent"], "null"),
  defineStage("archive-intent", "archive-postcut", ["completed"], "null"),
  defineStage("archive-renamed", "archive-postcut", ["archive-intent"], "null"),
  defineStage("archive-done", "archive-postcut", ["archive-renamed"], "null"),
  defineStage("marker-remove-intent", "archive-postcut", ["archive-done"], "null"),
  defineStage("marker-removed", "archive-postcut", ["marker-remove-intent"], "null"),
  defineStage("rollback-intent", "rollback-precut", ROLLBACK_FORWARD_STAGES, "detected-error"),
  defineStage("candidate-quarantine-intent", "rollback-precut", ["rollback-intent"], "repeat-prior"),
  defineStage("candidate-quarantined", "rollback-precut", ["candidate-quarantine-intent"], "repeat-prior"),
  defineStage("restore-wal-intent", "rollback-precut", ["candidate-quarantined"], "repeat-prior"),
  defineStage("wal-restored", "rollback-precut", ["restore-wal-intent"], "repeat-prior"),
  defineStage("restore-shm-intent", "rollback-precut", ["wal-restored"], "repeat-prior"),
  defineStage("shm-restored", "rollback-precut", ["restore-shm-intent"], "repeat-prior"),
  defineStage("restore-main-intent", "rollback-precut", ["shm-restored"], "repeat-prior"),
  defineStage("original-restored", "rollback-precut", ["restore-main-intent"], "repeat-prior"),
  defineStage("failed", "rollback-precut", ["original-restored"], "repeat-prior"),
  defineStage("retry-intent", "retry-failed", ["failed"], "repeat-prior"),
  defineStage(
    "retry-cleanup-candidate-quarantine-wal-intent",
    "retry-failed",
    ["retry-intent"],
    "repeat-prior"
  ),
  defineStage(
    "retry-cleanup-candidate-quarantine-wal-done",
    "retry-failed",
    ["retry-cleanup-candidate-quarantine-wal-intent"],
    "repeat-prior"
  ),
  defineStage(
    "retry-cleanup-candidate-quarantine-shm-intent",
    "retry-failed",
    ["retry-cleanup-candidate-quarantine-wal-done"],
    "repeat-prior"
  ),
  defineStage(
    "retry-cleanup-candidate-quarantine-shm-done",
    "retry-failed",
    ["retry-cleanup-candidate-quarantine-shm-intent"],
    "repeat-prior"
  ),
  defineStage(
    "retry-cleanup-candidate-quarantine-main-intent",
    "retry-failed",
    ["retry-cleanup-candidate-quarantine-shm-done"],
    "repeat-prior"
  ),
  defineStage(
    "retry-cleanup-candidate-quarantine-main-done",
    "retry-failed",
    ["retry-cleanup-candidate-quarantine-main-intent"],
    "repeat-prior"
  ),
  defineStage(
    "retry-snapshot-intent",
    "retry-failed",
    ["retry-cleanup-candidate-quarantine-main-done", "retry-snapshot-intent"],
    "repeat-prior"
  ),
  defineStage(
    "retry-reset-done",
    "retry-reset",
    ["retry-snapshot-intent", "snapshot-retry-done"],
    "null"
  ),
  ...abortDefinitions,
  defineStage(
    "aborted",
    "snapshot-abort",
    ["snapshot-abort-snapshot-main-done"],
    "repeat-prior"
  ),
  defineStage(
    "snapshot-retry-intent",
    "retry-aborted",
    ["aborted", "snapshot-retry-intent"],
    "repeat-prior"
  ),
  defineStage("snapshot-retry-done", "retry-aborted", ["snapshot-retry-intent"], "repeat-prior")
]);

export type RecoveryStage = typeof RECOVERY_STAGE_DEFINITIONS[number]["name"];
export interface RecoveryLayoutContext {
  readonly stage: RecoveryStage;
  readonly predecessor: RecoveryStage | "marker-only";
  readonly validateLayout?: () => void;
}
export type RecoveryStageDefinition = typeof RECOVERY_STAGE_DEFINITIONS[number];
export const RECOVERY_STAGES: readonly RecoveryStage[] = Object.freeze(
  RECOVERY_STAGE_DEFINITIONS.map(({ name }) => name)
);

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
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(marker.createdAt)
    || Number.isNaN(Date.parse(marker.createdAt))
    || new Date(marker.createdAt).toISOString() !== marker.createdAt
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

type WorkspaceMetadata = {
  logicalBasename: "work";
  dev: string;
  ino: string;
  uid: string;
  gid: string;
  mode: string;
  initialCtimeNs: string;
};

type OwnedManifest = {
  public: PieceManifest;
  snapshot: PieceManifest;
  snapshotTemp: PieceManifest;
  candidate: PieceManifest;
  candidateTemp: PieceManifest;
  quarantine: PieceManifest;
  candidateQuarantine: PieceManifest;
};

interface RecoveryReceipt {
  version: 1;
  sequence: string;
  prevHash: string | null;
  operationId: string;
  stage: RecoveryStage;
  databaseBasename: string;
  workspace: WorkspaceMetadata;
  original: PieceManifest;
  owned: OwnedManifest;
  candidateSha256: string | null;
  safeErrorCode: RecoverySafeErrorCode | null;
  rollbackFromStage: RecoveryStage | null;
}

const RECEIPT_KEYS = [
  "version", "sequence", "prevHash", "operationId", "stage", "databaseBasename",
  "workspace", "original", "owned", "candidateSha256", "safeErrorCode",
  "rollbackFromStage"
] as const;
const WORKSPACE_KEYS = [
  "logicalBasename", "dev", "ino", "uid", "gid", "mode", "initialCtimeNs"
] as const;
const FILE_METADATA_KEYS = [
  "logicalBasename", "dev", "ino", "size", "uid", "gid", "mode", "mtimeNs",
  "initialCtimeNs", "sha256"
] as const;
const PIECE_KEYS = ["main", "wal", "shm"] as const;
const OWNED_KEYS = [
  "public", "snapshot", "snapshotTemp", "candidate", "candidateTemp", "quarantine",
  "candidateQuarantine"
] as const;
const SAFE_ERROR_CODES = new Set<RecoverySafeErrorCode>([
  "SNAPSHOT_IO_FAILED", "SOURCE_DRIFT", "CANDIDATE_RECOVERY_FAILED", "CANDIDATE_INVALID",
  "METADATA_INVALID", "DESTINATION_EXISTS", "NOREPLACE_UNSUPPORTED", "NOREPLACE_FAILED",
  "FSYNC_FAILED"
]);
const MAX_UINT64 = (1n << 64n) - 1n;

const objectRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
): void => {
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
};

const canonicalUnsignedDecimal = (value: unknown, allowZero = true): string => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (parsed > MAX_UINT64 || (!allowZero && parsed === 0n)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return value;
};

const safeDatabaseBasename = (value: unknown): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || value === "."
    || value === ".."
    || basename(value) !== value
    || value.includes("\0")
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return value;
};

const expectedLogicalBasename = (
  slot: keyof OwnedManifest | "original",
  databaseBasename: string,
  operationId: string,
  piece: Piece
): string => slot === "snapshotTemp" || slot === "candidateTemp"
  ? `.${databaseBasename}.${operationId}.${piece}.tmp`
  : pieceBasename(databaseBasename, piece);

const validateFileMetadata = (
  value: unknown,
  logicalBasename: string
): FileMetadata => {
  const metadata = objectRecord(value);
  assertExactKeys(metadata, FILE_METADATA_KEYS);
  if (metadata.logicalBasename !== logicalBasename) return fail("GATEWAY_RECOVERY_INVALID");
  canonicalUnsignedDecimal(metadata.dev);
  canonicalUnsignedDecimal(metadata.ino, false);
  canonicalUnsignedDecimal(metadata.size);
  canonicalUnsignedDecimal(metadata.uid);
  canonicalUnsignedDecimal(metadata.gid);
  canonicalUnsignedDecimal(metadata.mode);
  canonicalUnsignedDecimal(metadata.mtimeNs);
  canonicalUnsignedDecimal(metadata.initialCtimeNs);
  if (
    metadata.uid !== String(APP_UID)
    || metadata.gid !== String(APP_GID)
    || metadata.mode !== String(0o600)
    || typeof metadata.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(metadata.sha256)
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return metadata as FileMetadata;
};

const validatePieceManifest = (
  value: unknown,
  slot: keyof OwnedManifest | "original",
  databaseBasename: string,
  operationId: string,
  requireAll = false
): PieceManifest => {
  const manifest = objectRecord(value);
  assertExactKeys(manifest, PIECE_KEYS);
  for (const piece of PIECES) {
    const metadata = manifest[piece];
    if (metadata === null) {
      if (requireAll) return fail("GATEWAY_RECOVERY_INVALID");
      continue;
    }
    validateFileMetadata(
      metadata,
      expectedLogicalBasename(slot, databaseBasename, operationId, piece)
    );
  }
  return manifest as PieceManifest;
};

const validateWorkspaceMetadata = (value: unknown): WorkspaceMetadata => {
  const workspace = objectRecord(value);
  assertExactKeys(workspace, WORKSPACE_KEYS);
  if (workspace.logicalBasename !== "work") return fail("GATEWAY_RECOVERY_INVALID");
  canonicalUnsignedDecimal(workspace.dev);
  canonicalUnsignedDecimal(workspace.ino, false);
  canonicalUnsignedDecimal(workspace.uid);
  canonicalUnsignedDecimal(workspace.gid);
  canonicalUnsignedDecimal(workspace.mode);
  canonicalUnsignedDecimal(workspace.initialCtimeNs);
  if (
    workspace.uid !== String(APP_UID)
    || workspace.gid !== String(APP_GID)
    || workspace.mode !== String(0o700)
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return workspace as WorkspaceMetadata;
};

const validateOwnedManifest = (
  value: unknown,
  databaseBasename: string,
  operationId: string
): OwnedManifest => {
  const owned = objectRecord(value);
  assertExactKeys(owned, OWNED_KEYS);
  for (const slot of OWNED_KEYS) {
    validatePieceManifest(owned[slot], slot, databaseBasename, operationId);
  }
  return owned as OwnedManifest;
};

const manifestMask = (manifest: PieceManifest): string => [
  ["main", "M"], ["wal", "W"], ["shm", "S"]
].filter(([piece]) => manifest[piece as Piece] !== null)
  .map(([, label]) => label)
  .join("");

const validateSnapshotIntentLayout = (owned: OwnedManifest): void => {
  if (
    manifestMask(owned.public) !== "MWS"
    || manifestMask(owned.snapshot) !== ""
    || manifestMask(owned.candidate) !== ""
    || manifestMask(owned.quarantine) !== ""
    || manifestMask(owned.candidateQuarantine) !== ""
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const snapshotPrefix = manifestMask(owned.snapshotTemp);
  const candidatePrefix = manifestMask(owned.candidateTemp);
  const prefixes = new Set(["", "W", "WS", "MWS"]);
  if (
    !prefixes.has(snapshotPrefix)
    || !prefixes.has(candidatePrefix)
    || (candidatePrefix !== "" && snapshotPrefix !== "MWS")
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
};

interface OwnedLayoutMask {
  public: string;
  snapshot: string;
  snapshotTemp: string;
  candidate: string;
  candidateTemp: string;
  quarantine: string;
  candidateQuarantine: string;
}

const ownedLayoutMask = (owned: OwnedManifest): OwnedLayoutMask => ({
  public: manifestMask(owned.public),
  snapshot: manifestMask(owned.snapshot),
  snapshotTemp: manifestMask(owned.snapshotTemp),
  candidate: manifestMask(owned.candidate),
  candidateTemp: manifestMask(owned.candidateTemp),
  quarantine: manifestMask(owned.quarantine),
  candidateQuarantine: manifestMask(owned.candidateQuarantine)
});

const layoutMask = (input: Partial<OwnedLayoutMask>): OwnedLayoutMask => ({
  public: "",
  snapshot: "",
  snapshotTemp: "",
  candidate: "",
  candidateTemp: "",
  quarantine: "",
  candidateQuarantine: "",
  ...input
});

const MAIN_STAGE_LAYOUTS: Readonly<Partial<Record<RecoveryStage, OwnedLayoutMask>>> = Object.freeze({
  "snapshot-complete": layoutMask({ public: "MWS", snapshot: "MWS", candidate: "MWS" }),
  "candidate-validated": layoutMask({ public: "MWS", snapshot: "MWS", candidate: "M" }),
  "quarantine-wal-intent": layoutMask({ public: "MWS", snapshot: "MWS", candidate: "M" }),
  "wal-quarantined": layoutMask({ public: "MS", snapshot: "MWS", candidate: "M", quarantine: "W" }),
  "quarantine-shm-intent": layoutMask({ public: "MS", snapshot: "MWS", candidate: "M", quarantine: "W" }),
  "shm-quarantined": layoutMask({ public: "M", snapshot: "MWS", candidate: "M", quarantine: "WS" }),
  "quarantine-main-intent": layoutMask({ public: "M", snapshot: "MWS", candidate: "M", quarantine: "WS" }),
  "originals-quarantined": layoutMask({ snapshot: "MWS", candidate: "M", quarantine: "MWS" }),
  "publish-intent": layoutMask({ snapshot: "MWS", candidate: "M", quarantine: "MWS" }),
  "candidate-published": layoutMask({ public: "M", snapshot: "MWS", quarantine: "MWS" }),
  "public-verified": layoutMask({ public: "M", snapshot: "MWS", quarantine: "MWS" }),
  "cleanup-quarantine-wal-intent": layoutMask({ public: "M", snapshot: "MWS", quarantine: "MWS" }),
  "cleanup-quarantine-wal-done": layoutMask({ public: "M", snapshot: "MWS", quarantine: "MS" }),
  "cleanup-quarantine-shm-intent": layoutMask({ public: "M", snapshot: "MWS", quarantine: "MS" }),
  "cleanup-quarantine-shm-done": layoutMask({ public: "M", snapshot: "MWS", quarantine: "M" }),
  "cleanup-quarantine-main-intent": layoutMask({ public: "M", snapshot: "MWS", quarantine: "M" }),
  "cleanup-quarantine-main-done": layoutMask({ public: "M", snapshot: "MWS" }),
  "cleanup-snapshot-wal-intent": layoutMask({ public: "M", snapshot: "MWS" }),
  "cleanup-snapshot-wal-done": layoutMask({ public: "M", snapshot: "MS" }),
  "cleanup-snapshot-shm-intent": layoutMask({ public: "M", snapshot: "MS" }),
  "cleanup-snapshot-shm-done": layoutMask({ public: "M", snapshot: "M" }),
  "cleanup-snapshot-main-intent": layoutMask({ public: "M", snapshot: "M" }),
  "cleanup-snapshot-main-done": layoutMask({ public: "M" }),
  "complete-intent": layoutMask({ public: "M" }),
  completed: layoutMask({ public: "M" }),
  "archive-intent": layoutMask({ public: "M" }),
  "archive-renamed": layoutMask({ public: "M" }),
  "archive-done": layoutMask({ public: "M" }),
  "marker-remove-intent": layoutMask({ public: "M" }),
  "marker-removed": layoutMask({ public: "M" })
});

const validateStageOwnedLayout = (
  stage: RecoveryStage,
  owned: OwnedManifest,
  rollbackFromStage: RecoveryStage | null,
  previous: RecoveryReceipt | undefined
): void => {
  if (stage === "snapshot-intent") {
    if (rollbackFromStage !== null) return fail("GATEWAY_RECOVERY_INVALID");
    validateSnapshotIntentLayout(owned);
    return;
  }
  const expected = MAIN_STAGE_LAYOUTS[stage];
  if (expected !== undefined) {
    if (
      rollbackFromStage !== null
      || JSON.stringify(ownedLayoutMask(owned)) !== JSON.stringify(expected)
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    return;
  }
  const definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === stage);
  if (!definition) return fail("GATEWAY_RECOVERY_INVALID");
  const equalOwned = (left: OwnedManifest, right: OwnedManifest): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  const cloneOwned = (value: OwnedManifest): OwnedManifest =>
    JSON.parse(JSON.stringify(value)) as OwnedManifest;
  if (definition.phase === "snapshot-abort") {
    if (rollbackFromStage !== null) return fail("GATEWAY_RECOVERY_INVALID");
    if (stage === "aborted") {
      if (JSON.stringify(ownedLayoutMask(owned)) !== JSON.stringify(layoutMask({ public: "MWS" }))) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      return;
    }
    const match = stage.match(
      /^snapshot-abort-(candidate-temp|candidate|snapshot-temp|snapshot)-(wal|shm|main)-(intent|done)$/u
    );
    if (!match) return fail("GATEWAY_RECOVERY_INVALID");
    const [, slotName, pieceName, boundary] = match;
    const slot = slotName === "candidate-temp"
      ? "candidateTemp"
      : slotName === "snapshot-temp"
        ? "snapshotTemp"
        : slotName as "candidate" | "snapshot";
    const piece = pieceName as Piece;
    if (!previous) {
      if (
        boundary !== "intent"
        || stage !== "snapshot-abort-candidate-temp-wal-intent"
        || manifestMask(owned.public) !== "MWS"
        || manifestMask(owned.quarantine) !== ""
        || manifestMask(owned.candidateQuarantine) !== ""
      ) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      return;
    }
    if (boundary === "intent") {
      if (!equalOwned(owned, previous.owned)) return fail("GATEWAY_RECOVERY_INVALID");
      return;
    }
    const expectedOwned = cloneOwned(previous.owned);
    expectedOwned[slot][piece] = null;
    if (!equalOwned(owned, expectedOwned)) return fail("GATEWAY_RECOVERY_INVALID");
    return;
  }
  if (definition.phase === "retry-aborted") {
    if (rollbackFromStage !== null) return fail("GATEWAY_RECOVERY_INVALID");
    if (stage === "snapshot-retry-done") {
      if (JSON.stringify(ownedLayoutMask(owned)) !== JSON.stringify(layoutMask({
        public: "MWS",
        snapshot: "MWS",
        candidate: "MWS"
      }))) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      return;
    }
    const mask = ownedLayoutMask(owned);
    if (
      mask.public !== "MWS"
      || mask.quarantine !== ""
      || mask.candidateQuarantine !== ""
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    if (!previous || previous.stage === "aborted") {
      if (JSON.stringify(ownedLayoutMask(owned)) !== JSON.stringify(layoutMask({ public: "MWS" }))) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
    }
    return;
  }
  if (stage === "retry-reset-done") {
    if (
      rollbackFromStage !== null
      || JSON.stringify(ownedLayoutMask(owned)) !== JSON.stringify(layoutMask({
        public: "MWS",
        snapshot: "MWS",
        candidate: "MWS"
      }))
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    return;
  }
  if (definition.phase === "rollback-precut") {
    if (rollbackFromStage === null || !previous) return fail("GATEWAY_RECOVERY_INVALID");
    if (stage === "rollback-intent") {
      const actual = ownedLayoutMask(owned);
      const prior = ownedLayoutMask(previous.owned);
      if (
        actual.public !== prior.public
        || actual.snapshot !== prior.snapshot
        || actual.snapshotTemp !== prior.snapshotTemp
        || actual.quarantine !== prior.quarantine
        || actual.candidateQuarantine !== prior.candidateQuarantine
      ) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      return;
    }
    if (stage === "candidate-quarantine-intent") {
      if (!equalOwned(owned, previous.owned)) return fail("GATEWAY_RECOVERY_INVALID");
      return;
    }
    if (stage === "candidate-quarantined") {
      const expectedOwned = cloneOwned(previous.owned);
      expectedOwned.candidateQuarantine = expectedOwned.candidate;
      expectedOwned.candidate = { main: null, wal: null, shm: null };
      if (!equalOwned(owned, expectedOwned)) return fail("GATEWAY_RECOVERY_INVALID");
      return;
    }
    const restore = stage.match(/^(?:restore-(wal|shm|main)-intent|(wal|shm)-restored|original-restored)$/u);
    if (restore) {
      if (stage.endsWith("-intent")) {
        if (!equalOwned(owned, previous.owned)) return fail("GATEWAY_RECOVERY_INVALID");
        return;
      }
      const piece = stage === "wal-restored" ? "wal" : stage === "shm-restored" ? "shm" : "main";
      const expectedOwned = cloneOwned(previous.owned);
      if (expectedOwned.public[piece] === null) {
        expectedOwned.public[piece] = expectedOwned.quarantine[piece];
        expectedOwned.quarantine[piece] = null;
      }
      if (!equalOwned(owned, expectedOwned)) return fail("GATEWAY_RECOVERY_INVALID");
      return;
    }
    if (stage === "failed") {
      if (
        !equalOwned(owned, previous.owned)
        || JSON.stringify(ownedLayoutMask(owned)) !== JSON.stringify(layoutMask({
          public: "MWS",
          snapshot: "MWS",
          candidateQuarantine: manifestMask(owned.candidateQuarantine)
        }))
      ) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      return;
    }
  }
  if (definition.phase === "retry-failed") {
    if (rollbackFromStage === null || !previous) return fail("GATEWAY_RECOVERY_INVALID");
    if (stage === "retry-snapshot-intent") {
      const mask = ownedLayoutMask(owned);
      if (
        mask.public !== "MWS"
        || mask.snapshot !== "MWS"
        || mask.snapshotTemp !== ""
        || mask.quarantine !== ""
        || mask.candidateQuarantine !== ""
      ) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      return;
    }
    if (stage === "retry-intent" || stage.endsWith("-intent")) {
      if (!equalOwned(owned, previous.owned)) return fail("GATEWAY_RECOVERY_INVALID");
      return;
    }
    const cleanupDone = stage.match(/^retry-cleanup-candidate-quarantine-(wal|shm|main)-done$/u);
    if (cleanupDone) {
      const expectedOwned = cloneOwned(previous.owned);
      expectedOwned.candidateQuarantine[cleanupDone[1] as Piece] = null;
      if (!equalOwned(owned, expectedOwned)) return fail("GATEWAY_RECOVERY_INVALID");
      return;
    }
  }
};

const pathForOwnedPiece = (
  paths: RecoveryPaths,
  databaseBasename: string,
  operationId: string,
  slot: keyof OwnedManifest,
  piece: Piece
): string => {
  const directory = slot === "public"
    ? paths.parent
    : slot === "snapshot" || slot === "snapshotTemp"
      ? paths.original
      : slot === "candidate" || slot === "candidateTemp"
        ? paths.candidate
        : slot === "quarantine"
          ? paths.quarantine
          : paths.candidateQuarantine;
  return slot === "snapshotTemp" || slot === "candidateTemp"
    ? tempPath(directory, databaseBasename, operationId, piece)
    : piecePath(directory, databaseBasename, piece);
};

const validateDirectoryByDescriptor = (path: string): BigIntStats => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const fdState = fstatSync(descriptor, { bigint: true });
    const pathState = assertPrivateDirectory(path);
    if (!sameIdentity(fdState, pathState)) return fail("GATEWAY_RECOVERY_INVALID");
    return fdState;
  } finally {
    closeSync(descriptor);
  }
};

const validateHeldOwnedFile = (path: string, expected: FileMetadata): number => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fdState = fstatSync(descriptor, { bigint: true });
    const pathState = lstatSync(path, { bigint: true });
    if (
      !fdState.isFile()
      || !pathState.isFile()
      || pathState.isSymbolicLink()
      || !sameIdentity(fdState, pathState)
      || fdState.uid !== BigInt(APP_UID)
      || fdState.gid !== BigInt(APP_GID)
      || fdState.nlink !== 1n
      || (fdState.mode & 0o777n) !== 0o600n
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    const actual = {
      logicalBasename: basename(path),
      dev: fdState.dev.toString(),
      ino: fdState.ino.toString(),
      size: fdState.size.toString(),
      uid: fdState.uid.toString(),
      gid: fdState.gid.toString(),
      mode: (fdState.mode & 0o777n).toString(),
      mtimeNs: fdState.mtimeNs.toString(),
      initialCtimeNs: expected.initialCtimeNs,
      sha256: createHash("sha256").update(readFileSync(descriptor)).digest("hex")
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

const filePrefixesEqual = (left: number, right: number, size: bigint): boolean => {
  const leftBuffer = Buffer.allocUnsafe(64 * 1024);
  const rightBuffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0n;
  while (offset < size) {
    const remaining = size - offset;
    const length = Number(remaining > BigInt(leftBuffer.byteLength)
      ? BigInt(leftBuffer.byteLength)
      : remaining);
    const position = Number(offset);
    if (!Number.isSafeInteger(position)) return fail("GATEWAY_RECOVERY_INVALID");
    const leftRead = readSync(left, leftBuffer, 0, length, position);
    const rightRead = readSync(right, rightBuffer, 0, length, position);
    if (
      leftRead !== length
      || rightRead !== length
      || !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))
    ) {
      return false;
    }
    offset += BigInt(length);
  }
  return true;
};

const holdSnapshotCrashAheadFile = (input: {
  path: string;
  expected: FileMetadata;
  sourcePath: string;
  sourceExpected: FileMetadata;
  repair: boolean;
}): number => {
  const descriptor = openSync(input.path, constants.O_RDWR | constants.O_NOFOLLOW);
  let sourceDescriptor: number | undefined;
  try {
    const state = fstatSync(descriptor, { bigint: true });
    const pathState = lstatSync(input.path, { bigint: true });
    if (
      !state.isFile()
      || !pathState.isFile()
      || pathState.isSymbolicLink()
      || !sameIdentity(state, pathState)
      || state.dev.toString() !== input.expected.dev
      || state.ino.toString() !== input.expected.ino
      || state.uid.toString() !== input.expected.uid
      || state.gid.toString() !== input.expected.gid
      || (state.mode & 0o777n).toString() !== input.expected.mode
      || state.nlink !== 1n
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    const durableSize = BigInt(canonicalUnsignedDecimal(input.expected.size));
    const sourceSize = BigInt(canonicalUnsignedDecimal(input.sourceExpected.size));
    if (state.size <= durableSize || state.size > sourceSize) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    sourceDescriptor = validateHeldOwnedFile(input.sourcePath, input.sourceExpected);
    if (!filePrefixesEqual(descriptor, sourceDescriptor, state.size)) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    if (input.repair) {
      const truncateSize = Number(durableSize);
      if (!Number.isSafeInteger(truncateSize)) return fail("GATEWAY_RECOVERY_INVALID");
      ftruncateSync(descriptor, truncateSize);
      fsyncSync(descriptor);
      fsyncDirectory(dirname(input.path));
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  } finally {
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }
};

const holdAndValidateOwnedLayout = (
  paths: RecoveryPaths,
  receipt: RecoveryReceipt,
  options: { repairSnapshotCrashAhead: boolean } = { repairSnapshotCrashAhead: false }
): { close(): void } => {
  const descriptors: number[] = [];
  try {
    const work = validateDirectoryByDescriptor(paths.work);
    const workspaceActual = {
      logicalBasename: "work",
      dev: work.dev.toString(),
      ino: work.ino.toString(),
      uid: work.uid.toString(),
      gid: work.gid.toString(),
      mode: (work.mode & 0o777n).toString(),
      initialCtimeNs: receipt.workspace.initialCtimeNs
    };
    if (JSON.stringify(workspaceActual) !== JSON.stringify(receipt.workspace)) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    if (JSON.stringify(readdirSync(paths.work).toSorted()) !== JSON.stringify(
      [...PRIVATE_DIRECTORIES].toSorted()
    )) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    const expectedPrivateChildren = new Map<string, Set<string>>([
      [paths.original, new Set()],
      [paths.candidate, new Set()],
      [paths.quarantine, new Set()],
      [paths.candidateQuarantine, new Set()]
    ]);
    const identities = new Set<string>();
    for (const slot of OWNED_KEYS) {
      for (const piece of PIECES) {
        const expected = receipt.owned[slot][piece];
        const path = pathForOwnedPiece(
          paths,
          receipt.databaseBasename,
          receipt.operationId,
          slot,
          piece
        );
        if (slot !== "public") expectedPrivateChildren.get(dirname(path))!.add(basename(path));
        if (expected === null) {
          if (existsSync(path)) return fail("GATEWAY_RECOVERY_INVALID");
          if (slot !== "public") expectedPrivateChildren.get(dirname(path))!.delete(basename(path));
          continue;
        }
        if (!existsSync(path)) return fail("GATEWAY_RECOVERY_INVALID");
        let descriptor: number;
        try {
          descriptor = validateHeldOwnedFile(path, expected);
        } catch (error) {
          const crashAhead = receipt.stage === "snapshot-intent"
            && (slot === "snapshotTemp" || slot === "candidateTemp");
          if (!crashAhead) throw error;
          const sourceExpected = receipt.original[piece];
          if (!sourceExpected) return fail("GATEWAY_RECOVERY_INVALID");
          descriptor = holdSnapshotCrashAheadFile({
            path,
            expected,
            sourcePath: piecePath(paths.parent, receipt.databaseBasename, piece),
            sourceExpected,
            repair: options.repairSnapshotCrashAhead
          });
        }
        descriptors.push(descriptor);
        const state = fstatSync(descriptor, { bigint: true });
        const identity = `${state.dev}:${state.ino}`;
        if (identities.has(identity)) return fail("GATEWAY_RECOVERY_INVALID");
        identities.add(identity);
      }
    }
    for (const [directory, names] of expectedPrivateChildren) {
      validateDirectoryByDescriptor(directory);
      if (
        JSON.stringify(readdirSync(directory).toSorted())
        !== JSON.stringify([...names].toSorted())
      ) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
    }
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        for (const descriptor of descriptors.splice(0).reverse()) closeSync(descriptor);
      }
    };
  } catch (error) {
    for (const descriptor of descriptors.splice(0).reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the validation error.
      }
    }
    if (error instanceof Error && error.message === "GATEWAY_RECOVERY_INVALID") throw error;
    return fail("GATEWAY_RECOVERY_INVALID");
  }
};

const rollbackStages: readonly RecoveryStage[] = ROLLBACK_FORWARD_STAGES;

const parseReceipt = (input: {
  bytes: string;
  file: string;
  marker: RecoveryMarker;
  expectedSequence: bigint;
  expectedPrevHash: string | null;
  previous: RecoveryReceipt | undefined;
}): RecoveryReceipt => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bytes);
  } catch {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const receipt = objectRecord(parsed);
  assertExactKeys(receipt, RECEIPT_KEYS);
  if (JSON.stringify(receipt) !== input.bytes || receipt.version !== 1) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const sequence = canonicalUnsignedDecimal(receipt.sequence, false);
  if (BigInt(sequence) !== input.expectedSequence || sequence.length > 20) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (receipt.prevHash !== input.expectedPrevHash) return fail("GATEWAY_RECOVERY_INVALID");
  if (
    receipt.operationId !== input.marker.operationId
    || !/^[0-9a-f]{32}$/u.test(String(receipt.operationId))
    || safeDatabaseBasename(receipt.databaseBasename) !== input.marker.databaseBasename
    || typeof receipt.stage !== "string"
    || !RECOVERY_STAGES.includes(receipt.stage as RecoveryStage)
    || input.file !== `${sequence.padStart(20, "0")}-${receipt.stage}.json`
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const stage = receipt.stage as RecoveryStage;
  const definition = RECOVERY_STAGE_DEFINITIONS.find((candidate) => candidate.name === stage);
  if (!definition) return fail("GATEWAY_RECOVERY_INVALID");
  const predecessor = input.previous?.stage ?? "marker-only";
  if (!(definition.predecessors as readonly string[]).includes(predecessor)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const workspace = validateWorkspaceMetadata(receipt.workspace);
  const original = validatePieceManifest(
    receipt.original,
    "original",
    input.marker.databaseBasename,
    input.marker.operationId,
    true
  );
  const owned = validateOwnedManifest(
    receipt.owned,
    input.marker.databaseBasename,
    input.marker.operationId
  );
  if (
    input.previous
    && (
      JSON.stringify(workspace) !== JSON.stringify(input.previous.workspace)
      || JSON.stringify(original) !== JSON.stringify(input.previous.original)
    )
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const candidateSha256 = receipt.candidateSha256;
  if (
    candidateSha256 !== null
    && (typeof candidateSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidateSha256))
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const safeErrorCode = receipt.safeErrorCode;
  if (safeErrorCode !== null && !SAFE_ERROR_CODES.has(safeErrorCode as RecoverySafeErrorCode)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const rollbackFromStage = receipt.rollbackFromStage;
  if (
    rollbackFromStage !== null
    && (
      typeof rollbackFromStage !== "string"
      || !rollbackStages.includes(rollbackFromStage as RecoveryStage)
    )
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  definition.resolveLayout({
    stage,
    predecessor,
    validateLayout: () => validateStageOwnedLayout(
      stage,
      owned,
      rollbackFromStage as RecoveryStage | null,
      input.previous
    )
  });
  if (definition.safeError === "null" && safeErrorCode !== null) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (definition.safeError === "detected-error" && safeErrorCode === null) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (
    definition.safeError === "repeat-prior"
    && (
      safeErrorCode === null
      || safeErrorCode !== input.previous?.safeErrorCode
    )
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  return receipt as unknown as RecoveryReceipt;
};

interface RecoveryJournal {
  operationId: string;
  databaseBasename: string;
  paths: RecoveryPaths;
  sequence: bigint;
  lastStage: RecoveryStage | undefined;
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

const buildReceiptBytes = (
  journal: RecoveryJournal,
  stage: RecoveryStage,
  sequenceValue: bigint,
  prevHash: string | null
): string => {
  const sequence = String(sequenceValue);
  if (sequence.length > 20) return fail("GATEWAY_RECOVERY_INVALID");
  const receipt = {
    version: 1,
    sequence,
    prevHash,
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
  return JSON.stringify(receipt);
};

const appendReceipt = (
  journal: RecoveryJournal,
  stage: RecoveryStage,
  dependencies: GatewayRecoveryDependencies
): void => {
  journal.sequence += 1n;
  const sequence = String(journal.sequence);
  if (sequence.length > 20) return fail("GATEWAY_RECOVERY_INVALID");
  const padded = sequence.padStart(20, "0");
  const bytes = buildReceiptBytes(journal, stage, journal.sequence, journal.prevHash);
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
  journal.lastStage = stage;
  dependencies.fault?.(`receipt:${stage}`);
};

const validateNextReceiptTemporary = (
  journal: RecoveryJournal,
  lastStage: RecoveryStage | undefined,
  temporaryName: string | undefined
): void => {
  if (temporaryName === undefined) return;
  const nextSequence = journal.sequence + 1n;
  const padded = String(nextSequence).padStart(20, "0");
  const predecessor = lastStage ?? "marker-only";
  const definitions = RECOVERY_STAGE_DEFINITIONS.filter((definition) =>
    (definition.predecessors as readonly string[]).includes(predecessor)
    && temporaryName === `${journal.operationId}-${padded}-${definition.name}.json.tmp`
  );
  if (definitions.length !== 1) return fail("GATEWAY_RECOVERY_INVALID");
  const definition = definitions[0]!;
  assertProtectedFile(join(journal.paths.receipts, temporaryName));
  const actual = readFileSync(join(journal.paths.receipts, temporaryName), "utf8");
  const safeErrors: readonly (RecoverySafeErrorCode | null)[] =
    definition.safeError === "detected-error"
      ? [...SAFE_ERROR_CODES]
      : definition.safeError === "null"
        ? [null]
        : [journal.safeErrorCode];
  const expectedBytes: string[] = [];
  for (const safeErrorCode of safeErrors) {
    const candidate: RecoveryJournal = {
      ...journal,
      initialCtimes: new Map(journal.initialCtimes),
      safeErrorCode,
      rollbackFromStage: definition.name === "rollback-intent"
        ? lastStage ?? null
        : definition.phase === "rollback-precut" || definition.phase === "retry-failed"
          ? journal.rollbackFromStage
          : null,
      candidateSha256: definition.name === "candidate-validated"
        ? sha256File(piecePath(journal.paths.candidate, journal.databaseBasename, "main"))
        : definition.name === "retry-reset-done"
          ? null
          : journal.candidateSha256
    };
    expectedBytes.push(buildReceiptBytes(
      candidate,
      definition.name,
      nextSequence,
      journal.prevHash
    ));
  }
  if (!expectedBytes.some((expected) => actual === expected || expected.startsWith(actual))) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
};

const moveNoReplace = (
  sourcePath: string,
  destinationPath: string,
  dependencies: GatewayRecoveryDependencies,
  boundary: string
): void => {
  const sourcePathState = lstatSync(sourcePath, { bigint: true });
  const directory = sourcePathState.isDirectory();
  if (directory) {
    assertPrivateDirectory(sourcePath);
  } else {
    assertProtectedFile(sourcePath);
  }
  if (existsSync(destinationPath)) return fail("GATEWAY_RECOVERY_INVALID");
  const descriptor = openSync(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  );
  try {
    const held = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(held, sourcePathState)) return fail("GATEWAY_RECOVERY_INVALID");
    dependencies.renameNoReplace({ sourcePath, destinationPath });
    const destination = lstatSync(destinationPath, { bigint: true });
    if (!sameIdentity(held, destination)) return fail("GATEWAY_RECOVERY_INVALID");
    fsyncDirectory(dirname(sourcePath));
    if (dirname(destinationPath) !== dirname(sourcePath)) {
      fsyncDirectory(dirname(destinationPath));
    }
    dependencies.fault?.(boundary);
  } finally {
    closeSync(descriptor);
  }
};

const unlinkHeldOwnedFile = (
  path: string,
  dependencies: GatewayRecoveryDependencies,
  boundary: string
): void => {
  if (!existsSync(path)) {
    fsyncDirectory(dirname(path));
    return;
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = fstatSync(descriptor, { bigint: true });
    const before = lstatSync(path, { bigint: true });
    if (
      !sameIdentity(held, before)
      || !held.isFile()
      || held.uid !== BigInt(APP_UID)
      || held.gid !== BigInt(APP_GID)
      || held.nlink !== 1n
      || (held.mode & 0o777n) !== 0o600n
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    dependencies.fault?.(`cleanup-before-unlink:${boundary}`);
    const current = lstatSync(path, { bigint: true });
    if (!sameIdentity(held, current)) return fail("GATEWAY_RECOVERY_INVALID");
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    dependencies.fault?.(`cleanup:${boundary}`);
  } finally {
    closeSync(descriptor);
  }
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
    sequence: 0n,
    lastStage: undefined,
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
  if (existsSync(paths.completedRoot)) {
    validateDirectoryByDescriptor(paths.completedRoot);
  } else {
    mkdirSync(paths.completedRoot, { mode: 0o700 });
    fsyncDirectory(paths.parent);
    validateDirectoryByDescriptor(paths.completedRoot);
  }
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
    sequence: 0n,
    lastStage: undefined,
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
): {
  journal: RecoveryJournal;
  lastStage: RecoveryStage | undefined;
  lastReceipt: RecoveryReceipt | undefined;
} => {
  const paths = pathsFor(databasePath);
  if (existsSync(paths.work)) {
    initializeWork(paths);
  } else if (existsSync(join(paths.completedRoot, marker.operationId))) {
    useCompletedWork(paths, marker.operationId);
  } else {
    return {
      journal: journalFromMarker(databasePath, marker),
      lastStage: undefined,
      lastReceipt: undefined
    };
  }
  const receiptEntries = readdirSync(paths.receipts).toSorted();
  const files = receiptEntries.filter((name) => /^\d{20}-.+\.json$/u.test(name));
  const temporaryReceipts = receiptEntries.filter((name) => name.endsWith(".json.tmp"));
  if (
    files.length + temporaryReceipts.length !== receiptEntries.length
    || temporaryReceipts.length > 1
    || (dirname(paths.work) === paths.completedRoot && temporaryReceipts.length !== 0)
  ) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  if (files.length === 0) {
    const journal = journalFromMarker(databasePath, marker);
    validateNextReceiptTemporary(journal, undefined, temporaryReceipts[0]);
    return {
      journal,
      lastStage: undefined,
      lastReceipt: undefined
    };
  }
  let expectedSequence = 1n;
  let expectedPrevHash: string | null = null;
  let lastReceipt: RecoveryReceipt | undefined;
  let lastBytes = "";
  for (const file of files) {
    const bytes = readFileSync(join(paths.receipts, file), "utf8");
    const receipt = parseReceipt({
      bytes,
      file,
      marker,
      expectedSequence,
      expectedPrevHash,
      previous: lastReceipt
    });
    expectedPrevHash = createHash("sha256").update(bytes).digest("hex");
    expectedSequence += 1n;
    lastReceipt = receipt;
    lastBytes = bytes;
  }
  if (!lastReceipt) return fail("GATEWAY_RECOVERY_INVALID");
  const initialCtimes = new Map<string, string>();
  seedInitialCtimes(lastReceipt.workspace, initialCtimes);
  seedInitialCtimes(lastReceipt.original, initialCtimes);
  seedInitialCtimes(lastReceipt.owned, initialCtimes);
  const journal: RecoveryJournal = {
      operationId: marker.operationId,
      databaseBasename: marker.databaseBasename,
      paths,
      sequence: expectedSequence - 1n,
      lastStage: lastReceipt.stage,
      prevHash: createHash("sha256").update(lastBytes).digest("hex"),
      original: lastReceipt.original,
      candidateSha256: lastReceipt.candidateSha256,
      safeErrorCode: lastReceipt.safeErrorCode,
      rollbackFromStage: lastReceipt.rollbackFromStage,
      initialCtimes
  };
  validateNextReceiptTemporary(journal, lastReceipt.stage, temporaryReceipts[0]);
  return {
    journal,
    lastStage: lastReceipt.stage,
    lastReceipt
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
  const copyOrder = ["wal", "shm", "main"] as const;
  const targets = [
    ["snapshotTemp", journal.paths.original],
    ["candidateTemp", journal.paths.candidate]
  ] as const;
  let initialized = false;
  for (const [, directory] of targets) {
    for (const piece of copyOrder) {
      const temporary = tempPath(
        directory,
        journal.databaseBasename,
        journal.operationId,
        piece
      );
      if (!existsSync(temporary)) {
        const descriptor = openSync(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        );
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        fsyncDirectory(directory);
        initialized = true;
      }
    }
  }
  if (journal.sequence === 0n) {
    appendReceipt(journal, "snapshot-intent", dependencies);
  } else if (initialized) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const chunk = Buffer.allocUnsafe(64 * 1024);
  for (const [slot, directory] of targets) {
    for (const piece of copyOrder) {
      const sourcePath = piecePath(journal.paths.parent, journal.databaseBasename, piece);
      const expected = journal.original[piece];
      if (!expected) return fail("GATEWAY_RECOVERY_INVALID");
      const sourceDescriptor = validateHeldOwnedFile(sourcePath, expected);
      const temporary = tempPath(
        directory,
        journal.databaseBasename,
        journal.operationId,
        piece
      );
      const destinationDescriptor = openSync(
        temporary,
        constants.O_RDWR | constants.O_NOFOLLOW
      );
      try {
        const sourceState = fstatSync(sourceDescriptor, { bigint: true });
        const destinationState = fstatSync(destinationDescriptor, { bigint: true });
        if (destinationState.size > sourceState.size) return fail("GATEWAY_RECOVERY_INVALID");
        let offset = Number(destinationState.size);
        if (!Number.isSafeInteger(offset)) return fail("GATEWAY_RECOVERY_INVALID");
        while (offset < Number(sourceState.size)) {
          const length = Math.min(chunk.byteLength, Number(sourceState.size) - offset);
          const read = readSync(sourceDescriptor, chunk, 0, length, offset);
          if (read !== length) return fail("SNAPSHOT_IO_FAILED");
          const written = writeSync(destinationDescriptor, chunk, 0, read, offset);
          if (written !== read) return fail("SNAPSHOT_IO_FAILED");
          offset += written;
          fsyncSync(destinationDescriptor);
          fsyncDirectory(directory);
          dependencies.fault?.(`snapshot-chunk:${slot}:${piece}:${offset}`);
          appendReceipt(journal, "snapshot-intent", dependencies);
        }
      } finally {
        try {
          closeSync(destinationDescriptor);
        } finally {
          closeSync(sourceDescriptor);
        }
      }
      dependencies.fault?.(`snapshot-copy:${basename(directory)}:${piece}`);
    }
  }
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
      unlinkHeldOwnedFile(path, dependencies, intent);
      appendReceipt(journal, done, dependencies);
    }
  }
  appendReceipt(journal, "aborted", dependencies);
};

const copySnapshotPieceIdempotent = (
  source: string,
  directory: string,
  journal: RecoveryJournal,
  piece: Piece,
  dependencies: GatewayRecoveryDependencies,
  boundary: string,
  progressStage: "retry-snapshot-intent" | "snapshot-retry-intent"
): void => {
  const temporary = tempPath(
    directory,
    journal.databaseBasename,
    journal.operationId,
    piece
  );
  const final = piecePath(directory, journal.databaseBasename, piece);
  const sourcePathState = assertProtectedFile(source);
  const sourceDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const sourceState = fstatSync(sourceDescriptor, { bigint: true });
  if (!sameIdentity(sourceState, sourcePathState)) {
    closeSync(sourceDescriptor);
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const sourceHash = createHash("sha256").update(readFileSync(sourceDescriptor)).digest("hex");
  if (existsSync(final)) {
    try {
      assertProtectedFile(final);
      if (sha256File(final) !== sourceHash) return fail("GATEWAY_RECOVERY_INVALID");
      if (existsSync(temporary)) return fail("GATEWAY_RECOVERY_INVALID");
      return;
    } finally {
      closeSync(sourceDescriptor);
    }
  }
  if (!existsSync(temporary)) {
    const created = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      fsyncSync(created);
    } finally {
      closeSync(created);
    }
    fsyncDirectory(directory);
    appendReceipt(journal, progressStage, dependencies);
  }
  const descriptor = openSync(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const destinationState = fstatSync(descriptor, { bigint: true });
    if (
      destinationState.size > sourceState.size
      || !filePrefixesEqual(descriptor, sourceDescriptor, destinationState.size)
    ) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    const sourceSize = Number(sourceState.size);
    let offset = Number(destinationState.size);
    if (!Number.isSafeInteger(sourceSize) || !Number.isSafeInteger(offset)) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (offset < sourceSize) {
      const length = Math.min(chunk.byteLength, sourceSize - offset);
      const read = readSync(sourceDescriptor, chunk, 0, length, offset);
      if (read !== length) return fail("SNAPSHOT_IO_FAILED");
      const written = writeSync(descriptor, chunk, 0, read, offset);
      if (written !== read) return fail("SNAPSHOT_IO_FAILED");
      offset += written;
      fsyncSync(descriptor);
      fsyncDirectory(directory);
      appendReceipt(journal, progressStage, dependencies);
    }
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      closeSync(sourceDescriptor);
    }
  }
  moveNoReplace(temporary, final, dependencies, boundary);
  appendReceipt(journal, progressStage, dependencies);
};

const continueAbortedRetry = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  startingStage: RecoveryStage
): "retry-reset-done" => {
  if (!journal.safeErrorCode || journal.rollbackFromStage !== null) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  let current = startingStage;
  if (current === "aborted") {
    appendReceipt(journal, "snapshot-retry-intent", dependencies);
    current = "snapshot-retry-intent";
  }
  if (current === "snapshot-retry-intent") {
    for (const directory of [journal.paths.original, journal.paths.candidate]) {
      for (const piece of PIECES) {
        copySnapshotPieceIdempotent(
          piecePath(journal.paths.parent, journal.databaseBasename, piece),
          directory,
          journal,
          piece,
          dependencies,
          `snapshot-retry:${basename(directory)}:${piece}`,
          "snapshot-retry-intent"
        );
      }
    }
    appendReceipt(journal, "snapshot-retry-done", dependencies);
    current = "snapshot-retry-done";
  }
  if (current === "snapshot-retry-done") {
    journal.safeErrorCode = null;
    journal.rollbackFromStage = null;
    journal.candidateSha256 = null;
    appendReceipt(journal, "retry-reset-done", dependencies);
    current = "retry-reset-done";
  }
  if (current !== "retry-reset-done") return fail("GATEWAY_RECOVERY_INVALID");
  return current;
};

const retryAbortedRecovery = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  continueAbortedRetry(journal, dependencies, "aborted");
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
  const order = RECOVERY_STAGE_DEFINITIONS
    .filter(({ phase }) => phase === "snapshot-abort")
    .map(({ name }) => name);
  let current = startingStage;
  while (current !== "aborted") {
    const index = order.indexOf(current);
    if (index < 0) return fail("GATEWAY_RECOVERY_INVALID");
    if (current.endsWith("-intent")) {
      const path = snapshotAbortPath(journal, current);
      unlinkHeldOwnedFile(path, dependencies, current);
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
  const captured = manifestForDirectory(
    journal.paths.candidate,
    journal.databaseBasename,
    journal.initialCtimes
  );
  if (PIECES.some((piece) => captured[piece] === null)) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  const held = new Map<Piece, number>();
  try {
    for (const piece of PIECES) {
      held.set(piece, validateHeldOwnedFile(
        piecePath(journal.paths.candidate, journal.databaseBasename, piece),
        captured[piece]!
      ));
    }
    dependencies.fault?.("candidate-before-open");
    for (const piece of PIECES) {
      const path = piecePath(journal.paths.candidate, journal.databaseBasename, piece);
      const pathState = lstatSync(path, { bigint: true });
      const heldState = fstatSync(held.get(piece)!, { bigint: true });
      if (!sameIdentity(pathState, heldState)) return fail("GATEWAY_RECOVERY_INVALID");
    }
    const database = new Database(candidatePath, { fileMustExist: true });
    try {
      database.pragma("wal_checkpoint(TRUNCATE)");
      database.pragma("journal_mode = DELETE");
    } finally {
      database.close();
    }
    const mainPathState = lstatSync(candidatePath, { bigint: true });
    if (!sameIdentity(mainPathState, fstatSync(held.get("main")!, { bigint: true }))) {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    for (const piece of ["wal", "shm"] as const) {
      const path = piecePath(journal.paths.candidate, journal.databaseBasename, piece);
      dependencies.fault?.(`candidate-before-sidecar-unlink:${piece}`);
      if (existsSync(path)) {
        const pathState = lstatSync(path, { bigint: true });
        const heldState = fstatSync(held.get(piece)!, { bigint: true });
        if (!sameIdentity(pathState, heldState)) return fail("GATEWAY_RECOVERY_INVALID");
        unlinkSync(path);
      }
    }
    fsyncDirectory(journal.paths.candidate);
    chmodSync(candidatePath, 0o600);
    validateImmutable(candidatePath, dependencies);
    journal.candidateSha256 = sha256File(candidatePath);
    appendReceipt(journal, "candidate-validated", dependencies);
  } finally {
    for (const descriptor of [...held.values()].reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the recovery error.
      }
    }
  }
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

const continueFailedRetry = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies,
  startingStage: RecoveryStage
): "retry-reset-done" => {
  if (!journal.safeErrorCode || !journal.rollbackFromStage) {
    return fail("GATEWAY_RECOVERY_INVALID");
  }
  let current = startingStage;
  if (current === "failed") {
    appendReceipt(journal, "retry-intent", dependencies);
    current = "retry-intent";
  }
  const cleanup = [
    ["wal", "retry-cleanup-candidate-quarantine-wal-intent",
      "retry-cleanup-candidate-quarantine-wal-done"],
    ["shm", "retry-cleanup-candidate-quarantine-shm-intent",
      "retry-cleanup-candidate-quarantine-shm-done"],
    ["main", "retry-cleanup-candidate-quarantine-main-intent",
      "retry-cleanup-candidate-quarantine-main-done"]
  ] as const;
  let previous: RecoveryStage = "retry-intent";
  for (const [piece, intent, done] of cleanup) {
    const order = RECOVERY_STAGES;
    if (order.indexOf(current) > order.indexOf(done)) {
      previous = done;
      continue;
    }
    if (current === previous) {
      appendReceipt(journal, intent, dependencies);
      current = intent;
    }
    if (current === intent) {
      const path = piecePath(journal.paths.candidateQuarantine, journal.databaseBasename, piece);
      unlinkHeldOwnedFile(path, dependencies, intent);
      appendReceipt(journal, done, dependencies);
      current = done;
    }
    if (current !== done) return fail("GATEWAY_RECOVERY_INVALID");
    previous = done;
  }
  if (current === "retry-cleanup-candidate-quarantine-main-done") {
    appendReceipt(journal, "retry-snapshot-intent", dependencies);
    current = "retry-snapshot-intent";
  }
  if (current === "retry-snapshot-intent") {
    for (const piece of PIECES) {
      copySnapshotPieceIdempotent(
        piecePath(journal.paths.original, journal.databaseBasename, piece),
        journal.paths.candidate,
        journal,
        piece,
        dependencies,
        `retry-snapshot:${piece}`,
        "retry-snapshot-intent"
      );
    }
    journal.safeErrorCode = null;
    journal.rollbackFromStage = null;
    journal.candidateSha256 = null;
    appendReceipt(journal, "retry-reset-done", dependencies);
    current = "retry-reset-done";
  }
  if (current !== "retry-reset-done") return fail("GATEWAY_RECOVERY_INVALID");
  return current;
};

const retryFailedRecovery = (
  journal: RecoveryJournal,
  dependencies: GatewayRecoveryDependencies
): void => {
  continueFailedRetry(journal, dependencies, "failed");
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
      unlinkHeldOwnedFile(path, dependencies, intent);
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
    let rootDescriptor: number | undefined;
    let markerDescriptor: number | undefined;
    try {
      if (existsSync(journal.paths.activeRoot)) {
        rootDescriptor = openSync(
          journal.paths.activeRoot,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        const rootPathState = assertPrivateDirectory(journal.paths.activeRoot);
        if (!sameIdentity(fstatSync(rootDescriptor, { bigint: true }), rootPathState)) {
          return fail("GATEWAY_RECOVERY_INVALID");
        }
      }
      if (existsSync(markerPath)) {
        markerDescriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const markerPathState = assertProtectedFile(markerPath);
        if (!sameIdentity(fstatSync(markerDescriptor, { bigint: true }), markerPathState)) {
          return fail("GATEWAY_RECOVERY_INVALID");
        }
        dependencies.fault?.("marker-before-unlink");
        const markerCurrent = lstatSync(markerPath, { bigint: true });
        if (!sameIdentity(fstatSync(markerDescriptor, { bigint: true }), markerCurrent)) {
          return fail("GATEWAY_RECOVERY_INVALID");
        }
        unlinkSync(markerPath);
        fsyncDirectory(journal.paths.activeRoot);
        dependencies.fault?.("marker-unlinked");
      }
      if (existsSync(journal.paths.activeRoot)) {
        if (rootDescriptor === undefined) return fail("GATEWAY_RECOVERY_INVALID");
        dependencies.fault?.("active-root-before-rmdir");
        const rootCurrent = lstatSync(journal.paths.activeRoot, { bigint: true });
        if (!sameIdentity(fstatSync(rootDescriptor, { bigint: true }), rootCurrent)) {
          return fail("GATEWAY_RECOVERY_INVALID");
        }
        if (readdirSync(journal.paths.activeRoot).length !== 0) {
          return fail("GATEWAY_RECOVERY_INVALID");
        }
        rmdirSync(journal.paths.activeRoot);
        fsyncDirectory(journal.paths.parent);
        dependencies.fault?.("active-root-removed");
      }
    } finally {
      if (markerDescriptor !== undefined) closeSync(markerDescriptor);
      if (rootDescriptor !== undefined) closeSync(rootDescriptor);
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
  const completed = join(pathsFor(databasePath).completedRoot, operationId);
  if (!existsSync(completed)) return undefined;
  const loaded = loadActiveJournal(databasePath, {
    version: 1,
    operationId,
    databaseBasename: basename(databasePath),
    workspaceBasename: "work",
    createdAt: "1970-01-01T00:00:00.000Z"
  });
  if (loaded.lastReceipt) {
    const held = holdAndValidateOwnedLayout(loaded.journal.paths, loaded.lastReceipt);
    held.close();
  }
  return loaded.lastStage === "marker-remove-intent" || loaded.lastStage === "marker-removed"
    ? loaded.lastStage
    : undefined;
};

const completedOperationIds = (databasePath: string): string[] => {
  const completedRoot = pathsFor(databasePath).completedRoot;
  if (!existsSync(completedRoot)) return [];
  assertPrivateDirectory(completedRoot);
  return readdirSync(completedRoot)
    .filter((name) => /^[0-9a-f]{32}$/u.test(name) && lastCompletedStage(databasePath, name))
    .toSorted();
};

const recoveryIsPostCut = (journal: RecoveryJournal): boolean => {
  if (journal.lastStage === undefined) return false;
  const definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === journal.lastStage);
  return definition?.phase === "forward-postcut" || definition?.phase === "archive-postcut";
};

const postCutFaultIsBlockable = (error: unknown): boolean => !(
  error instanceof Error
  && (
    error.message === "SIMULATED_SIGKILL"
    || error.message === "GATEWAY_RECOVERY_INVALID"
    || error.message === "GATEWAY_RECOVERY_LOCK_INVALID"
  )
);

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
    const recoveryPaths = pathsFor(databasePath);
    if (existsSync(recoveryPaths.activeRoot)) {
      if (readMarker(databasePath) !== undefined) {
        return fail("GATEWAY_RECOVERY_RESUME_REQUIRED");
      }
      const pendingCompleted = completedOperationIds(databasePath)
        .filter((operationId) => lastCompletedStage(databasePath, operationId) === "marker-remove-intent");
      if (pendingCompleted.length > 0) {
        return fail(pendingCompleted.length === 1
          ? "GATEWAY_RECOVERY_RESUME_REQUIRED"
          : "GATEWAY_RECOVERY_INVALID");
      }
      if (readdirSync(recoveryPaths.activeRoot).length !== 0) {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      rmdirSync(recoveryPaths.activeRoot);
      fsyncDirectory(recoveryPaths.parent);
    }
    const operationId = operationIdFromDependencies(dependencies);
    const createdAt = dependencies.now().toISOString();
    const journal = createRecoveryJournal(databasePath, operationId, createdAt, dependencies);
    try {
      copySnapshots(journal, dependencies);
    } catch (error) {
      if (
        error instanceof Error
        && (
          error.message === "SNAPSHOT_IO_FAILED"
          || (error as NodeJS.ErrnoException).code === "ENOSPC"
        )
      ) {
        abortSnapshotFailure(journal, dependencies, "SNAPSHOT_IO_FAILED");
        return { kind: "execution", status: "aborted", operationId };
      }
      throw error;
    }
    try {
      recoverCandidate(journal, dependencies);
    } catch (error) {
      if (error instanceof Error && error.message === "SIMULATED_SIGKILL") throw error;
      if (error instanceof Error && error.message === "GATEWAY_RECOVERY_INVALID") throw error;
      rollbackCandidateFailure(
        journal,
        dependencies,
        error instanceof Error && error.message === "CANDIDATE_INVALID"
          ? "CANDIDATE_INVALID"
          : "CANDIDATE_RECOVERY_FAILED"
      );
      return { kind: "execution", status: "restored", operationId };
    }
    try {
      installCandidate(journal, dependencies);
      cleanupInstalled(journal, dependencies);
      archiveCompleted(journal, dependencies);
    } catch (error) {
      if (recoveryIsPostCut(journal) && postCutFaultIsBlockable(error)) {
        return { kind: "execution", status: "blocked", operationId };
      }
      throw error;
    }
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
          try {
            continueArchiveCompleted(
              loaded.journal,
              dependencies,
              "marker-remove-intent"
            );
          } catch (error) {
            if (recoveryIsPostCut(loaded.journal) && postCutFaultIsBlockable(error)) {
              return {
                kind: "execution",
                status: "blocked",
                operationId: terminal.operationId
              };
            }
            throw error;
          }
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
    if (loaded.lastReceipt) {
      const held = holdAndValidateOwnedLayout(journal.paths, loaded.lastReceipt, {
        repairSnapshotCrashAhead: true
      });
      held.close();
    }
    let current = loaded.lastStage;
    let definition = current === undefined
      ? undefined
      : RECOVERY_STAGE_DEFINITIONS.find((candidate) => candidate.name === current);
    if (definition?.phase === "snapshot-abort" && current !== "aborted") {
      if (current === undefined) return fail("GATEWAY_RECOVERY_INVALID");
      continueSnapshotAbort(journal, dependencies, current);
      current = "aborted";
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
    }
    if (definition?.phase === "rollback-precut" && current !== "failed") {
      if (current === undefined) return fail("GATEWAY_RECOVERY_INVALID");
      continueRollback(journal, dependencies, current);
      current = "failed";
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
    }
    if (definition?.phase === "retry-failed") {
      if (input.action !== "resume") return fail("GATEWAY_RECOVERY_INVALID");
      if (current === undefined) return fail("GATEWAY_RECOVERY_INVALID");
      current = continueFailedRetry(journal, dependencies, current);
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
    } else if (definition?.phase === "retry-aborted") {
      if (input.action !== "resume") return fail("GATEWAY_RECOVERY_INVALID");
      if (current === undefined) return fail("GATEWAY_RECOVERY_INVALID");
      current = continueAbortedRetry(journal, dependencies, current);
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
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
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
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
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
    } else if (input.action === "retry") {
      return fail("GATEWAY_RECOVERY_INVALID");
    }
    if (current === undefined) {
      copySnapshots(journal, dependencies);
      current = "snapshot-complete";
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
    } else if (current === "snapshot-intent") {
      copySnapshots(journal, dependencies);
      current = "snapshot-complete";
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
    }
    if (current === "snapshot-complete" || current === "retry-reset-done") {
      recoverCandidate(journal, dependencies);
      current = "candidate-validated";
      definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
    }
    try {
      if (definition?.phase === "forward-precut") {
        current = continueInstallCandidate(journal, dependencies, current);
        definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
      }
      if (current === "public-verified" || definition?.phase === "forward-postcut") {
        current = continueCleanupInstalled(journal, dependencies, current);
        definition = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === current);
      }
      if (current !== "completed" && definition?.phase !== "archive-postcut") {
        return fail("GATEWAY_RECOVERY_INVALID");
      }
      continueArchiveCompleted(journal, dependencies, current);
    } catch (error) {
      if (recoveryIsPostCut(journal) && postCutFaultIsBlockable(error)) {
        return {
          kind: "execution",
          status: "blocked",
          operationId: marker.operationId
        };
      }
      throw error;
    }
    return {
      kind: "execution",
      status: "recovered",
      operationId: marker.operationId
    };
  }
  if (input.action !== "status") return fail("GATEWAY_RECOVERY_INVALID");
  if (!existsSync(pathsFor(databasePath).work)) {
    return {
      kind: "status",
      state: "initializing",
      operationId: marker.operationId
    };
  }
  const loaded = loadActiveJournal(databasePath, marker);
  if (loaded.lastReceipt) {
    const held = holdAndValidateOwnedLayout(loaded.journal.paths, loaded.lastReceipt);
    held.close();
  }
  if (loaded.lastStage !== undefined) {
    return {
      kind: "status",
      state: "active",
      operationId: marker.operationId,
      stage: loaded.lastStage
    };
  }
  return {
    kind: "status",
    state: "initializing",
    operationId: marker.operationId
  };
}
