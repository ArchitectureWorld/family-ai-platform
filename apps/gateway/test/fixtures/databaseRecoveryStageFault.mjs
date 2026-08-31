export function createRecoveryStageFault(target, errorCode = "SIMULATED_SIGKILL") {
  let fired = false;
  return (boundary) => {
    if (!fired && boundary === target) {
      fired = true;
      throw new Error(errorCode);
    }
  };
}
