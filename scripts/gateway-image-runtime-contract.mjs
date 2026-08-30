#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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

export function inspectGatewayImageRuntime(imageId, expected) {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(imageId)
    || !/^[0-9a-f]{64}$/u.test(expected?.launcherSha256 ?? "")
    || expected?.pythonVersion !== "3.11.2"
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
    "import hashlib,json,os,platform,stat;p='/app/apps/gateway/runtime/gateway_lock_exec.py';s=os.stat(p);print(json.dumps({'pythonVersion':platform.python_version(),'launcher':{'path':p,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'nlink':s.st_nlink,'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest()}},separators=(',',':')))"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  if (
    probe.pythonVersion !== expected.pythonVersion
    || probe.launcher?.path !== "/app/apps/gateway/runtime/gateway_lock_exec.py"
    || probe.launcher?.uid !== 1000
    || probe.launcher?.gid !== 1000
    || probe.launcher?.mode !== 0o755
    || probe.launcher?.nlink !== 1
    || !/^[0-9a-f]{64}$/u.test(probe.launcher?.sha256 ?? "")
    || probe.launcher.sha256 !== expected.launcherSha256
  ) {
    throw new Error("GATEWAY_IMAGE_RUNTIME_INVALID");
  }
  return {
    expected: {
      pythonVersion: expected.pythonVersion,
      launcherSha256: expected.launcherSha256
    },
    actual: {
      user: "node",
      entrypoint: GATEWAY_IMAGE_ENTRYPOINT,
      cmd: GATEWAY_IMAGE_CMD,
      pythonVersion: probe.pythonVersion,
      launcher: probe.launcher
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (
    process.argv.length !== 9
    || process.argv[2] !== "inspect"
    || process.argv[3] !== "--image-id"
    || process.argv[5] !== "--expected-launcher-sha256"
    || process.argv[7] !== "--expected-python-version"
  ) {
    process.stderr.write("GATEWAY_IMAGE_RUNTIME_INVALID\n");
    process.exit(1);
  }
  try {
    process.stdout.write(`${JSON.stringify(inspectGatewayImageRuntime(process.argv[4], {
      launcherSha256: process.argv[6],
      pythonVersion: process.argv[8]
    }))}\n`);
  } catch {
    process.stderr.write("GATEWAY_IMAGE_RUNTIME_INVALID\n");
    process.exit(1);
  }
}
