export function applyAdminShellState(shell, state) {
  if (!shell?.classList || typeof shell.classList.toggle !== "function") {
    throw new Error("ADMIN_SHELL_INVALID");
  }
  shell.classList.toggle("is-management", state === "management");
}
