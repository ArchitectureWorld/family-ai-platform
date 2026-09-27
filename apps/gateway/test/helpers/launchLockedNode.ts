import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const harness = String.raw`
import fcntl, os, sys
database, role, node, target, *args = sys.argv[1:]
parent = os.path.dirname(database)
lock_path = os.path.join(parent, ".family-ai-gateway.lock")
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
os.chmod(lock_path, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
os.dup2(fd, 3, inheritable=True)
if fd != 3:
    os.close(fd)
else:
    os.set_inheritable(3, True)
os.environ["FAMILY_AI_GATEWAY_LOCK_ROLE"] = role
os.environ["FAMILY_AI_GATEWAY_LOCK_DATABASE"] = database
os.execv(node, [node, "--import", "tsx", target, *args])
`;

export function spawnLockedSource(input: {
  root: string;
  role: "gateway" | "migrate" | "provision" | "recovery";
  databasePath: string;
  target: string;
  args?: readonly string[];
  timeout?: number;
}): SpawnSyncReturns<string> {
  return spawnSync("python3", [
    "-c",
    harness,
    input.databasePath,
    input.role,
    process.execPath,
    input.target,
    ...(input.args ?? [])
  ], {
    cwd: input.root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
    ...(input.timeout === undefined ? {} : { timeout: input.timeout })
  });
}
