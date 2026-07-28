const states = new Map(
  [...document.querySelectorAll("[data-state]")]
    .map(element => [element.dataset.state, element])
);

export function showAdminState(name) {
  if (!states.has(name)) throw new Error("ADMIN_STATE_INVALID");
  for (const [stateName, element] of states) {
    element.hidden = stateName !== name;
  }
}

showAdminState("initializing");
