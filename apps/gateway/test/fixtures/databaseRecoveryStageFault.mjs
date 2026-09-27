export function createRecoveryStageFault(target, errorCode = "SIMULATED_SIGKILL") {
  let fired = false;
  return (boundary) => {
    if (!fired && boundary === target) {
      fired = true;
      throw new Error(errorCode);
    }
  };
}

export function createRecoveryStageKill(target) {
  let fired = false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^${escaped
    .replace("<slot>", "[^:]+")
    .replace("<piece>", "(?:main|wal|shm)")
    .replace("<offset>", "[0-9]+")}$`, "u");
  return (boundary) => {
    const matches = pattern.test(boundary);
    if (!fired && matches) {
      fired = true;
      process.kill(process.pid, "SIGKILL");
    }
  };
}
