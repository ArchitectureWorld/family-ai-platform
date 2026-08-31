export function createRecoveryDiskFault(target, errorCode = "ENOSPC") {
  let fired = false;
  return (boundary) => {
    if (!fired && boundary === target) {
      fired = true;
      const error = new Error(errorCode);
      error.code = errorCode;
      throw error;
    }
  };
}
