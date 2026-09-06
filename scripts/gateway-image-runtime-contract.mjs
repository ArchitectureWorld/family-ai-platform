#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GATEWAY_IMAGE_ENTRYPOINT = [
  "python3",
  "apps/gateway/runtime/gateway_lock_exec.py",
  "--database-from-env",
  "GATEWAY_DATABASE_PATH",
  "--"
];
export const GATEWAY_IMAGE_CMD = ["node", "apps/gateway/dist/index.js"];
export const RECOVERY_BUILT_FILES = [
  "databaseRecovery.js", "databaseRecoveryRuntime.js", "recoverGatewayDatabase.js",
  "databaseSecurity.js", "databaseLock.js", "migrate.js"
].map(name => `apps/gateway/dist/${name}`);

export function readGatewayBuildDigests() {
  return Object.fromEntries(RECOVERY_BUILT_FILES.map(path =>
    [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
}

export function inspectGatewayImageRuntime(imageId, expected) {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(imageId)
    || !/^[0-9a-f]{64}$/u.test(expected?.launcherSha256 ?? "")
    || expected?.pythonVersion !== "3.11.2"
    || !/^[0-9a-f]{64}$/u.test(expected?.renameHelperSha256 ?? "")
    || JSON.stringify(Object.keys(expected?.builtSha256 ?? {}).sort()) !== JSON.stringify([...RECOVERY_BUILT_FILES].sort())
    || Object.values(expected?.builtSha256 ?? {}).some(value => !/^[0-9a-f]{64}$/u.test(value))
  ) {
    throw new Error("GATEWAY_IMAGE_RUNTIME_INVALID");
  }
  const image = JSON.parse(execFileSync(
    "docker",
    ["image", "inspect", imageId],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ))[0];
  if (
    image?.Id !== imageId
    || image.Config?.User !== "node"
    || JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(GATEWAY_IMAGE_ENTRYPOINT)
    || JSON.stringify(image.Config?.Cmd) !== JSON.stringify(GATEWAY_IMAGE_CMD)
  ) {
    throw new Error("GATEWAY_IMAGE_RUNTIME_INVALID");
  }
  const probe = JSON.parse(execFileSync("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--entrypoint", "python3", imageId,
    "-c",
    "import hashlib,json,os,platform,stat;p='/app/apps/gateway/runtime/gateway_lock_exec.py';s=os.lstat(p);print(json.dumps({'pythonVersion':platform.python_version(),'launcher':{'path':p,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'nlink':s.st_nlink,'regular':stat.S_ISREG(s.st_mode),'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest()}},separators=(',',':')))"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  if (
    probe.pythonVersion !== expected.pythonVersion
    || probe.launcher?.path !== "/app/apps/gateway/runtime/gateway_lock_exec.py"
    || probe.launcher?.uid !== 1000
    || probe.launcher?.gid !== 1000
    || probe.launcher?.mode !== 0o755
    || probe.launcher?.nlink !== 1
    || probe.launcher?.regular !== true
    || !/^[0-9a-f]{64}$/u.test(probe.launcher?.sha256 ?? "")
    || probe.launcher.sha256 !== expected.launcherSha256
  ) {
    throw new Error("GATEWAY_IMAGE_RUNTIME_INVALID");
  }
  const recoveryFiles = JSON.parse(execFileSync("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--entrypoint", "python3", imageId, "-c",
    "import hashlib,json,os,stat,sys;files=json.loads(sys.argv[1]);rows=[]\nfor p in files:\n s=os.lstat('/app/'+p);rows.append({'path':p,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'nlink':s.st_nlink,'regular':stat.S_ISREG(s.st_mode),'sha256':hashlib.sha256(open('/app/'+p,'rb').read()).hexdigest()})\nprint(json.dumps(rows,separators=(',',':')))",
    JSON.stringify(["apps/gateway/runtime/rename_noreplace.py", ...RECOVERY_BUILT_FILES])
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  for (const row of recoveryFiles) {
    const helper = row.path === "apps/gateway/runtime/rename_noreplace.py";
    if (!row.regular || row.uid !== 1000 || row.gid !== 1000 || row.nlink !== 1
      || row.mode !== (helper ? 0o755 : 0o644)
      || row.sha256 !== (helper ? expected.renameHelperSha256 : expected.builtSha256[row.path])) {
      throw new Error("GATEWAY_IMAGE_RUNTIME_INVALID");
    }
  }
  return {
    expected: {
      pythonVersion: expected.pythonVersion,
      launcherSha256: expected.launcherSha256,
      renameHelperSha256: expected.renameHelperSha256,
      builtSha256: expected.builtSha256
    },
    actual: {
      user: "node",
      entrypoint: GATEWAY_IMAGE_ENTRYPOINT,
      cmd: GATEWAY_IMAGE_CMD,
      pythonVersion: probe.pythonVersion,
      launcher: probe.launcher,
      recoveryFiles
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === "built-digests") {
    process.stdout.write(`${JSON.stringify(readGatewayBuildDigests())}\n`);
    process.exit(0);
  }
  if (
    process.argv.length !== 11
    || process.argv[2] !== "inspect"
    || process.argv[3] !== "--image-id"
    || process.argv[5] !== "--expected-launcher-sha256"
    || process.argv[7] !== "--expected-python-version"
    || process.argv[9] !== "--expected-recovery-json"
  ) {
    process.stderr.write("GATEWAY_IMAGE_RUNTIME_INVALID\n");
    process.exit(1);
  }
  try {
    const recovery = JSON.parse(process.argv[10]);
    if (JSON.stringify(Object.keys(recovery).sort()) !== '["builtSha256","renameHelperSha256"]') {
      throw new Error("GATEWAY_IMAGE_RUNTIME_INVALID");
    }
    process.stdout.write(`${JSON.stringify(inspectGatewayImageRuntime(process.argv[4], {
      launcherSha256: process.argv[6],
      pythonVersion: process.argv[8],
      renameHelperSha256: recovery.renameHelperSha256,
      builtSha256: recovery.builtSha256
    }))}\n`);
  } catch {
    process.stderr.write("GATEWAY_IMAGE_RUNTIME_INVALID\n");
    process.exit(1);
  }
}
