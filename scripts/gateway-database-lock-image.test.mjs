import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const image = process.env.GATEWAY_LOCK_TEST_IMAGE;

test("built Gateway image exposes only the approved CMD-through-launcher contract", {
  skip: image === undefined
}, () => {
  const inspected = JSON.parse(execFileSync(
    "docker",
    ["image", "inspect", image],
    { encoding: "utf8" }
  ))[0];
  assert.deepEqual(inspected.Config.Entrypoint, [
    "python3",
    "apps/gateway/runtime/gateway_lock_exec.py",
    "--database-from-env",
    "GATEWAY_DATABASE_PATH",
    "--"
  ]);
  assert.deepEqual(inspected.Config.Cmd, ["node", "apps/gateway/dist/index.js"]);
  assert.equal(inspected.Config.User, "node");

  const runtime = execFileSync("docker", [
    "run", "--rm", "--entrypoint", "python3", image, "-c",
    "import hashlib,os,stat; p='/app/apps/gateway/runtime/gateway_lock_exec.py'; s=os.stat(p); print(os.getuid(),os.getgid(),stat.S_IMODE(s.st_mode),s.st_nlink,hashlib.sha256(open(p,'rb').read()).hexdigest())"
  ], { encoding: "utf8" }).trim().split(" ");
  assert.deepEqual(runtime.slice(0, 4), ["1000", "1000", "493", "1"]);
  assert.match(runtime[4] ?? "", /^[0-9a-f]{64}$/u);
});
