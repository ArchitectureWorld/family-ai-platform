function clone(value) {
  return structuredClone(value);
}

export function createStore(initialState) {
  const initial = clone(initialState);
  let state = clone(initial);
  const listeners = new Set();

  function getState() {
    return clone(state);
  }

  function setState(update) {
    const current = clone(state);
    const next = typeof update === "function"
      ? update(current)
      : { ...current, ...clone(update) };
    state = clone(next);
    const snapshot = getState();
    for (const listener of [...listeners]) listener(clone(snapshot));
    return snapshot;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function reset() {
    state = clone(initial);
    const snapshot = getState();
    for (const listener of [...listeners]) listener(clone(snapshot));
    return snapshot;
  }

  return { getState, setState, subscribe, reset };
}
