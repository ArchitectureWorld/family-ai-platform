import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const sha256File = path => sha256(readFileSync(path));

export function failure(prefix, message) {
  const error = new Error(`${prefix}:${message}`);
  error.code = message;
  return error;
}

export function die(prefix, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.startsWith(`${prefix}:`) ? message : `${prefix}:${message}`}\n`);
  process.exit(1);
}

export function parseArgs(values, { command, required = [], optional = [], flags = [] }) {
  let index = 0;
  if (command) {
    if (values[0] !== command) throw new Error(`EXPECTED_${command.toUpperCase().replaceAll("-", "_")}`);
    index = 1;
  }
  const allowed = new Set([...required, ...optional]);
  const flagSet = new Set(flags);
  const result = {};
  while (index < values.length) {
    const key = values[index];
    if (flagSet.has(key)) {
      if (result[key] !== undefined) throw new Error("DUPLICATE_ARGUMENT");
      result[key] = true;
      index += 1;
      continue;
    }
    const value = values[index + 1];
    if (!allowed.has(key) || value === undefined || result[key] !== undefined) {
      throw new Error("INVALID_ARGUMENTS");
    }
    result[key] = value;
    index += 2;
  }
  for (const key of required) if (!result[key]) throw new Error(`MISSING_${key.slice(2).toUpperCase().replaceAll("-", "_")}`);
  return result;
}

export function requireSafeId(value, name = "ID") {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value ?? "")) throw new Error(`${name}_INVALID`);
  return value;
}

export function requireHex(value, length, name) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value ?? "")) throw new Error(`${name}_INVALID`);
  return value;
}

function prohibitedRoot(path, repositoryRoot) {
  const home = process.env.HOME ? resolve(process.env.HOME) : null;
  return path === "/" || path === home || path === resolve(repositoryRoot);
}

export function requireAbsolute(path, name, { exists = true, type, mode, repositoryRoot = process.cwd(), allowSymlink = false } = {}) {
  if (!isAbsolute(path ?? "") || path.includes(`${sep}..${sep}`) || path.endsWith(`${sep}..`)) {
    throw new Error(`${name}_PATH_INVALID`);
  }
  const normalized = resolve(path);
  if (normalized !== path || prohibitedRoot(normalized, repositoryRoot)) throw new Error(`${name}_PATH_UNSAFE`);
  if (!exists) {
    if (existsSync(path) || lstatExists(path)) throw new Error(`${name}_MUST_BE_NEW`);
    const parent = dirname(path);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`${name}_PARENT_INVALID`);
    if (realpathSync(parent) !== parent) throw new Error(`${name}_PARENT_SYMLINK`);
    return path;
  }
  if (!existsSync(path)) throw new Error(`${name}_MISSING`);
  const lst = lstatSync(path);
  if (lst.isSymbolicLink() && !allowSymlink) throw new Error(`${name}_SYMLINK`);
  if (!allowSymlink && realpathSync(path) !== path) throw new Error(`${name}_SYMLINK_ANCESTOR`);
  if (type === "file" && !lst.isFile()) throw new Error(`${name}_NOT_FILE`);
  if (type === "dir" && !lst.isDirectory()) throw new Error(`${name}_NOT_DIRECTORY`);
  if (mode !== undefined && (lst.mode & 0o777) !== mode) throw new Error(`${name}_MODE_INVALID`);
  return path;
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export function readJson(path, name = "JSON") {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`${name}_INVALID`); }
}

export function requireRegular0600(path, name) {
  requireAbsolute(path, name, { type: "file" });
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error(`${name}_MODE_INVALID`);
  return path;
}

export function verifySidecar(path, expected, name) {
  requireRegular0600(path, name);
  requireHex(expected, 64, `EXPECTED_${name}_SHA256`);
  const actual = sha256File(path);
  if (actual !== expected) throw new Error(`${name}_SHA256_MISMATCH`);
  const sidecar = `${path}.sha256`;
  requireRegular0600(sidecar, `${name}_SIDECAR`);
  const match = readFileSync(sidecar, "utf8").match(/^([0-9a-f]{64})  ([^/\n]+)\n$/);
  if (!match || match[1] !== actual || match[2] !== basename(path)) throw new Error(`${name}_SIDECAR_INVALID`);
  return actual;
}

export function atomicWrite(path, bytes, mode = 0o600) {
  requireAbsolute(path, "OUTPUT", { exists: false });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(temporary, mode);
  renameSync(temporary, path);
  const parentFd = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
}

export function sealJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  atomicWrite(path, bytes, 0o600);
  const digest = sha256(bytes);
  atomicWrite(`${path}.sha256`, Buffer.from(`${digest}  ${basename(path)}\n`), 0o600);
  return digest;
}

export function ensureContained(root, path, name = "PATH") {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${name}_OUTSIDE_ROOT`);
  return rel.split(sep).join("/");
}

export function inventoryTree(root) {
  requireAbsolute(root, "TREE_ROOT", { type: "dir" });
  const records = [];
  const visit = (absolute, rel) => {
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) throw new Error(`TREE_SYMLINK:${childRel}`);
      if (metadata.isDirectory()) {
        records.push({ path: childRel, type: "directory", mode: metadata.mode & 0o777 });
        visit(child, childRel);
      } else if (metadata.isFile()) {
        records.push({ path: childRel, type: "file", mode: metadata.mode & 0o777, size: metadata.size, sha256: sha256File(child) });
      } else {
        throw new Error(`TREE_SPECIAL_FILE:${childRel}`);
      }
    }
  };
  visit(root, "");
  return records;
}

export function copyInventory(source, destination, inventory) {
  mkdirSync(destination, { mode: 0o700 });
  for (const record of inventory) {
    const target = join(destination, record.path);
    if (record.type === "directory") {
      mkdirSync(target, { recursive: false, mode: record.mode });
      chmodSync(target, record.mode);
    } else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, record.path), target, constants.COPYFILE_EXCL);
      chmodSync(target, record.mode);
    }
  }
}

export function inventoryDigest(records) {
  return sha256(Buffer.from(records.map(record => `${record.type}\0${record.path}\0${record.mode.toString(8)}\0${record.size ?? ""}\0${record.sha256 ?? ""}\0`).join("")));
}

export function fsyncTree(root) {
  const records = inventoryTree(root).slice().reverse();
  for (const record of records) {
    const path = join(root, record.path);
    const fd = openSync(path, record.type === "directory" ? constants.O_RDONLY : constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const fd = openSync(root, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
